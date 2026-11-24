#!/usr/bin/env node
// @ts-check
// One worker for the desk (desk.js). It asks the desk for the next free
// task, works on it with Claude Code, renews the lease while it works and
// gives the task back. Then it asks again, until the desk says everything is
// done, the budget is spent or it has waited too long with nothing to do.
//
//   node desk-worker.js <dir> --name w1 [--desk http://127.0.0.1:8790] [--max-tasks 100] [--model claude-opus-5-5]
//
// Start two or three with different names for the group; start one alone,
// on a fresh copy of the same round, for the solo comparison.
//
// Claude Code runs headless in <dir>/work with file tools only (read, write,
// edit, search): no shell, no web, no MCP. --permission-mode acceptEdits lets
// it write without asking inside work/ only; anything else would need a
// question, which headless means no. (dontAsk refused even writes in work/.)
// It never sees the checks: the desk runs them. It runs on ANTHROPIC_API_KEY if set, else on the Claude
// Code sign-in of the machine.

const path = require('path');
const { execFile } = require('child_process');

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const dir = args[0];
if (!dir || dir.startsWith('--')) { console.error('Usage: node desk-worker.js <dir> --name w1 [--desk http://127.0.0.1:8790]'); process.exit(1); }
const NAME = opt('--name', 'w1'), DESK = opt('--desk', 'http://127.0.0.1:8790');
const MAX_TASKS = Number(opt('--max-tasks', '100')), MODEL = opt('--model', 'claude-opus-5-5');
const POLL_MS = Number(process.env.DESK_POLL_MS || 10000), IDLE_MS = Number(process.env.DESK_IDLE_MS || 30 * 60000);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(method, route, payload) {
  const r = await fetch(DESK + route, { method, headers: { 'content-type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
  return { code: r.status, json: await r.json().catch(() => ({})) };
}

function prompt(job) {
  const t = job.task;
  const others = job.board.filter(x => x.id !== t.id).map(x => `- ${x.id} "${x.title}": ${x.status}${x.holder ? ` (held by ${x.holder})` : ''}${x.needs.length ? `, needs ${x.needs.join(', ')}` : ''}`).join('\n');
  const notes = t.notes.map(n => `[${n.by}] ${n.text}`).join('\n\n');
  const comments = job.comments.map(c => `[${c.by}] ${c.text}`).join('\n');
  return [
    `You are ${NAME}, one of several workers on a shared goal. Nobody assigns work: each worker takes one task from a shared desk, does it, and gives it back. The other workers write in the same folder (the current folder) at the same time.`,
    `Goal: ${job.goal}`,
    `Your task: ${t.id} "${t.title}"\n${t.detail || ''}`,
    t.spec ? `How the task will be judged (you cannot run this; the desk runs it when you finish):\n\n${t.spec}` : 'There is no automatic check for this task: a person will review it.',
    notes ? `Notes on this task from earlier tries and from people:\n\n${notes}` : '',
    others ? `The other tasks on the desk:\n${others}` : '',
    comments ? `Comments from people on the desk:\n${comments}` : '',
    'Work only on your task. Read files other workers wrote if you need them, but change them only if your task says so.',
    'When you finish, answer with a short note for the others: what you did, which files, anything left open. If you cannot do the task (for example something it needs is missing), start your answer with STUCK: and say why.',
  ].filter(Boolean).join('\n\n');
}

function runClaude(text) {
  const cmd = process.env.DESK_CLAUDE || 'claude';
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['GH_TOKEN', 'GITHUB_TOKEN'].includes(k)));
  return new Promise(resolve => {
    execFile(cmd, ['-p', '--model', MODEL, '--max-turns', '40', '--tools', 'Read,Write,Edit,Glob,Grep',
      '--permission-mode', 'acceptEdits', '--strict-mcp-config', '--output-format', 'json', '--', text],
    { cwd: path.join(dir, 'work'), env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: Number(process.env.DESK_AGENT_TIMEOUT_MS || 40 * 60000) },
    (err, stdout) => {
      try {
        const j = JSON.parse(String(stdout).slice(String(stdout).indexOf('{')));
        const cost = typeof j.total_cost_usd === 'number' ? j.total_cost_usd : 0;
        if (j.is_error) return resolve({ ok: false, note: `The agent stopped: ${j.subtype || ''} ${String(j.result || '').slice(0, 300)}`, cost });
        resolve({ ok: true, note: String(j.result || '').trim(), cost });
      } catch { resolve({ ok: false, note: `The agent did not answer: ${String(err && err.message || 'no output').slice(0, 300)}`, cost: 0 }); }
    });
  });
}

async function main() {
  let taken = 0, idleSince = Date.now();
  while (taken < MAX_TASKS) {
    const { json: job } = await call('GET', `/next?worker=${encodeURIComponent(NAME)}`);
    if (job.status === 'done' || job.status === 'budget') { console.log(`${NAME}: stopping, the desk says ${job.status}.`); return; }
    if (job.status !== 'task') {
      if (Date.now() - idleSince > IDLE_MS) { console.log(`${NAME}: stopping, nothing free for too long.`); return; }
      await sleep(POLL_MS); continue;
    }
    taken += 1;
    console.log(`${NAME}: took ${job.task.id} "${job.task.title}"`);
    let lost = false;
    const beat = setInterval(async () => {
      const r = await call('POST', `/beat?lease=${job.lease}`).catch(() => ({ code: 0 }));
      if (r.code === 410) lost = true;
    }, job.beat_seconds * 1000);
    const r = await runClaude(prompt(job));
    clearInterval(beat);
    const stuck = !r.ok || /^STUCK:/i.test(r.note);
    const back = await call('POST', '/release', { lease: job.lease, reason: stuck ? 'stuck' : 'submitted', note: r.note, cost_usd: r.cost });
    console.log(`${NAME}: gave back ${job.task.id}: ${back.code === 410 || lost ? 'too late, the lease had run out' : back.json.status}`);
    idleSince = Date.now();
  }
  console.log(`${NAME}: stopping after ${taken} tasks.`);
}

main().catch(e => { console.error(`${NAME}: ${e.message}`); process.exit(1); });
