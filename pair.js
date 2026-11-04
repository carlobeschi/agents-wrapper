#!/usr/bin/env node
// The Pair (pilot): two agents pair-program the way two people at one desk do.
// `node pair.js <pair.json>`.
//
// The driver (Codex) works on a small task in a throwaway folder. Its sandbox
// lets it write and run commands only inside that folder, with no network. The
// app reads its live event stream (`codex exec --json`). The navigator (Claude,
// read-only, from agents.json) watches. After each file change or command, or
// after `look_secs` of activity, it is shown what happened since its last look
// and either stays silent or cuts in. A cut-in stops the driver mid-task and
// resumes the same session with what the navigator said. The driver can also
// ask for help at any moment by writing a line "HELP: <question>": the app
// pauses it, puts the question to the navigator and resumes it with the answer.
//
// When the driver finishes a turn, the app runs the hidden tests (`tests`, a
// folder the driver never gets) on a copy of its work, inside a sandbox. If
// they fail, the driver is resumed with the failures. If they pass, the
// navigator is asked to sign off ("Next: end"), or says what is still missing.
// Done means tests pass and both agree.
//
// Config:
// { "title": "...", "task": "what to build", "starter": "folder copied in (optional)",
//   "tests": "folder of hidden tests", "proof": ["node", "--test", "hidden-tests/x.test.js"],
//   "navigator": "claude", "driver": { "model": "gpt-6-luna" },
//   "look_secs": 45, "max_looks": 40, "max_rounds": 6, "max_minutes": 40 }
// Relative paths are from the config file's folder. Run folder:
// ~/.agent-dispatch/pairs/<run>/: work/ (the driver's folder), check/ (where
// the tests run), events.jsonl (raw driver events), timeline.json, episode.md,
// steps/ (every navigator prompt). Nothing is published from here.

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { spawn } = require('child_process');
const { HOME_DIR, loadConfig, agentEnv, stamp } = require('./config');
const { killTree, stripAnsi, UNATTENDED } = require('./talk');
const { run } = require('./motion');

const usage = () => { console.error('usage: node pair.js <pair.json>'); process.exit(2); };

// The driver's commands. `-s workspace-write`: writes only inside its folder,
// no network. `--ignore-user-config --ignore-rules`: nothing loosened by the
// laptop's own Codex settings. Resume has no -s flag, so the same policy goes
// in as config. "{model}" and "{session}" are filled in; the prompt goes on stdin.
const SANDBOX = ['--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-c', 'sandbox_mode="workspace-write"',
  '-c', 'sandbox_workspace_write.network_access=false'];
const DRIVER_START  = ['codex', 'exec', '--json', '-s', 'workspace-write', ...SANDBOX, '-m', '{model}', '-'];
const DRIVER_RESUME = ['codex', 'exec', '--json', ...SANDBOX, '-m', '{model}', 'resume', '{session}', '-'];
// The hidden tests run inside Codex's sandbox too: the code under test was
// written by an agent, so it never runs bare on the laptop.
const PROOF_WRAP = ['codex', 'sandbox', '--'];

const HELP = /^[ \t>*_`]*HELP:[ \t]*(.+)$/im;
const SILENT = /^\W*silent\W*$/i;
const END = /^[ \t]*[*_`]*next[*_`]*[ \t]*:[ \t]*[*_`]*end[*_`]*\W*$/im;
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + ` … (${s.length - n} more chars)` : s; };
const tail = (s, n) => { s = String(s ?? ''); return s.length > n ? '… ' + s.slice(-n) : s; };

// ---- The driver's events, as lines anyone can read ----

// One Codex JSONL event as a timeline entry, or null for bookkeeping events.
// Unknown shapes are kept by type, so a format change shows up instead of vanishing.
function describe(ev) {
  const item = ev.item || {};
  if (ev.type === 'item.completed') {
    switch (item.type) {
      case 'agent_message':     return { kind: 'say', text: item.text || '' };
      case 'reasoning':         return { kind: 'think', text: item.text || item.summary || '' };
      case 'command_execution': return { kind: 'run', text: `$ ${item.command}\n${tail(item.aggregated_output, 1500)}`.trim(), exit: item.exit_code, meaningful: true };
      case 'file_change':       return { kind: 'edit', text: (item.changes || []).map(c => `${c.kind || 'change'} ${c.path}`).join('\n') || 'files changed', meaningful: true };
      case 'todo_list':         return { kind: 'plan', text: (item.items || []).map(i => `${i.completed ? '[x]' : '[ ]'} ${i.text}`).join('\n') };
      case 'error':             return { kind: 'error', text: item.message || JSON.stringify(item) };
      default:                  return { kind: item.type || 'item', text: clip(JSON.stringify(item), 400) };
    }
  }
  if (ev.type === 'error' || ev.type === 'turn.failed') return { kind: 'error', text: ev.message || ev.error?.message || JSON.stringify(ev) };
  return null;
}

const sessionOf = ev => ev.thread_id || ev.session_id || (ev.type === 'session.created' && ev.id) || null;

// ---- Prompts ----

function driverBrief(p, nav) {
  return [
    `You are the driver in a pair-programming session. ${nav.label}, an AI agent from another lab, is your navigator: it watches what you do as you do it and may cut in at any moment. A person is following along, and the session is recorded as a show.`,
    `Your folder is the current directory. You can edit files and run commands in it; there is no network.`,
    `When you are stuck, or a decision would really benefit from a second opinion, write a line on its own: "HELP: <your question>". The app pauses you, asks ${nav.label}, and brings you its answer. Use it when it helps, not for reassurance.`,
    `When ${nav.label} cuts in, take it seriously but think for yourself: if it is wrong, say why and carry on.`,
    `When you think the task is done, check it yourself, then finish your turn with a short summary. Hidden tests will then be run on your work.`,
    '',
    '## The task',
    '',
    p.task,
  ].join('\n');
}

const NAV_RULES = drv => [
  `Cut in only for something that matters: a bug, a wrong approach, a missed requirement, a test it should run. Not for style, and not to praise. Each cut-in stops ${drv} mid-task, as a tap on the shoulder would.`,
  `If nothing needs saying, reply with exactly "(silent)". If you cut in, write one to three sentences, said to ${drv}.`,
  `You can read the files in the folder with your tools, but you cannot change them.`,
];

function navPrompt(p, me, drv, timeline, since, why) {
  const recent = timeline.slice(since);
  const before = timeline.slice(Math.max(0, since - 12), since);
  return [
    `You are ${me.label}, the navigator in a pair-programming session. ${drv}, an AI agent from another lab, is the driver: it writes the code and runs the commands. You watch and may cut in at any moment. A person is following along, and the session is recorded as a show.`,
    UNATTENDED(drv),
    ...(why === 'help' ? [`${drv} has asked you for help (the last entry below). Answer it directly, in a few sentences, said to ${drv}.`] : NAV_RULES(drv)),
    '',
    '## The task',
    '',
    p.task,
    '',
    ...(before.length ? ['## Earlier (you have seen this)', '', ...before.map(entry), ''] : []),
    '## Since your last look',
    '',
    ...(recent.length ? recent.map(entry) : ['(nothing new)']),
  ].join('\n');
}

function signOffPrompt(p, me, drv, timeline, proof) {
  return [
    `You are ${me.label}, the navigator in a pair-programming session with ${drv}, who drove. ${drv} says the task is done, and the hidden tests pass:`,
    '', '```', tail(proof.out, 1500), '```', '',
    `Look at the work (you can read the files in the folder). If you agree it is done, say so in a sentence and end with a line "Next: end". If something is still missing or wrong, say what, in one to three sentences said to ${drv}, without that line.`,
    UNATTENDED(drv),
    '',
    '## The task', '', p.task, '',
    '## The session, last part', '', ...timeline.slice(-15).map(entry),
  ].join('\n');
}

const WHO = { say: 'driver says', think: 'driver thinks', run: 'driver runs', edit: 'driver edits', plan: 'driver plan', cut: 'navigator cuts in', help: 'driver asks for help', answer: 'navigator answers', check: 'hidden tests', signoff: 'navigator sign-off', error: 'error' };
const entry = e => `[${Math.round(e.at)}s, ${WHO[e.kind] || e.kind}] ${clip(e.text, 2000)}`;

// ---- Running the driver ----

// One driver turn: resolves when the process ends, with how it ended. Calls
// onEvent for each timeline entry as it streams. Stopped early by stop(why).
function driverTurn(p, prompt, session, dir, onEvent) {
  const args = (session ? p.driver.resume : p.driver.start).map(s => s.split('{model}').join(p.driver.model || '').split('{session}').join(session || ''));
  // An empty model ("-m", "") would be refused; drop the pair.
  const mi = args.indexOf('-m');
  if (mi >= 0 && !args[mi + 1]) args.splice(mi, 2);
  const [cmd, ...rest] = args;
  let child, buf = '', stopped = null, sid = session;
  const done = new Promise(resolve => {
    try {
      child = spawn(cmd, rest, { cwd: path.join(dir, 'work'), env: agentEnv(p.driver.env), shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    } catch (e) { return resolve({ code: -1, error: e.message }); }
    let err = '';
    const raw = fs.createWriteStream(path.join(dir, 'events.jsonl'), { flags: 'a' });
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        raw.write(line + '\n');
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        sid = sid || sessionOf(ev);
        const e = describe(ev);
        if (e && !stopped) onEvent(e);
      }
    });
    child.stderr.on('data', d => { err = (err + d).slice(-16000); });
    child.on('error', e => { err += e.message; });
    child.on('close', code => { raw.end(); resolve({ code, err: stripAnsi(err), stopped, session: sid }); });
  });
  return { done, stop: why => { if (!stopped) { stopped = why; killTree(child); } }, session: () => sid };
}

// ---- The hidden tests ----

function copyDir(from, to, skip = new Set(['node_modules', '.git'])) {
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.has(f.name) || f.isSymbolicLink()) continue;
    const a = path.join(from, f.name), b = path.join(to, f.name);
    if (f.isDirectory()) copyDir(a, b, skip); else fs.copyFileSync(a, b);
  }
}

// Fresh copy of the work plus the hidden tests, run under the sandbox wrapper.
function proof(p, dir) {
  const check = path.join(dir, 'check');
  fs.rmSync(check, { recursive: true, force: true });
  copyDir(path.join(dir, 'work'), check);
  copyDir(p.tests, path.join(check, 'hidden-tests'));
  const [cmd, ...args] = [...p.proof_wrap, ...p.proof];
  return new Promise(resolve => {
    let out = '';
    const child = spawn(cmd, args, { cwd: check, env: agentEnv(p.driver.env), shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => killTree(child), 5 * 60 * 1000);
    child.stdout.on('data', d => { out = (out + d).slice(-20000); });
    child.stderr.on('data', d => { out = (out + d).slice(-20000); });
    child.on('error', e => { out += e.message; });
    child.on('close', code => { clearTimeout(timer); resolve({ pass: code === 0, code, out: stripAnsi(out) }); });
  });
}

// ---- The session ----

async function session(p, dir, nav) {
  const t0 = Date.now();
  const at = () => (Date.now() - t0) / 1000;
  const timeline = [];
  const save = () => fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify({ title: p.title, task: p.task, models: { driver: p.driver.model || null, navigator: nav.model || null }, timeline }, null, 2));
  const add = (kind, text, extra = {}) => { const e = { at: at(), kind, text, ...extra }; timeline.push(e); save(); console.log(`  ${Math.round(e.at)}s ${WHO[kind] || kind}: ${clip(text.split('\n')[0], 100)}`); return e; };
  const drv = 'Codex';
  let looks = 0, seen = 0, sid = null, next = driverBrief(p, nav), result = 'unfinished', looking = false, lastLook = Date.now();

  for (let round = 1; round <= p.max_rounds; round++) {
    if (at() > p.max_minutes * 60) { result = 'out of time'; break; }
    let help = null, cut = null, ended = false;
    const turn = driverTurn(p, next, sid, dir, e => {
      const ev = add(e.kind, e.text, e.exit != null ? { exit: e.exit } : {});
      const asked = e.kind === 'say' && HELP.exec(e.text);
      if (asked && !help && !cut) { help = asked[1].trim(); turn.stop('help'); return; }
      // The navigator looks after a meaningful step, or when enough time has gone by.
      const due = e.meaningful || Date.now() - lastLook > p.look_secs * 1000;
      if (due && !looking && looks < p.max_looks && !help && !cut) look(ev);
    });
    // Runs alongside the driver: the driver keeps working while the navigator thinks.
    async function look() {
      looking = true; looks++; lastLook = Date.now();
      const from = seen; seen = timeline.length;
      try {
        const said = (await run(dir, `look-${String(looks).padStart(2, '0')}`, nav, navPrompt(p, nav, drv, timeline, from), path.join(dir, 'work'))).trim();
        // A look that comes back after the turn ended is too late to cut in.
        if (said && !SILENT.test(said) && !help && !cut && !ended) { cut = said; add('cut', said); turn.stop('cut'); }
      } catch (e) { add('error', `navigator: ${e.message.split('\n')[0]}`); }
      finally { looking = false; }
    }
    const r = await turn.done;
    ended = true;
    sid = r.session || sid;
    if (r.code !== 0 && !r.stopped) {
      add('error', `driver: exit ${r.code}${r.error ? ` (${r.error})` : ''}\n${tail(r.err, 600)}`);
      if (!sid) { result = 'driver failed'; break; }
    }
    if (!sid) { result = 'driver gave no session id, so it cannot be resumed'; add('error', result); break; }
    if (r.stopped === 'help') {
      add('help', help);
      looks++;
      let answer;
      try { answer = (await run(dir, `help-${String(looks).padStart(2, '0')}`, nav, navPrompt(p, nav, drv, timeline, seen, 'help'), path.join(dir, 'work'))).trim(); }
      catch (e) { answer = `(${nav.label} could not answer: ${e.message.split('\n')[0]})`; }
      seen = timeline.length;
      add('answer', answer);
      next = `${nav.label} answers your question:\n\n${answer}\n\nCarry on with the task.`;
      round--; // a pause for help is not a new attempt at the task
      continue;
    }
    if (r.stopped === 'cut') {
      next = `${nav.label} cuts in:\n\n${cut}\n\nRespond briefly if you want to, then carry on with the task.`;
      round--;
      continue;
    }
    // The driver finished a turn on its own: run the hidden tests.
    const pr = await proof(p, dir);
    add('check', `${pr.pass ? 'PASS' : 'FAIL'} (exit ${pr.code})\n${tail(pr.out, 1500)}`, { pass: pr.pass });
    if (!pr.pass) {
      next = `The hidden tests fail on your work:\n\n\`\`\`\n${tail(pr.out, 2500)}\n\`\`\`\n\nFix it. You can't see the tests themselves, only this output.`;
      continue;
    }
    let verdict;
    try { verdict = (await run(dir, `signoff-${round}`, nav, signOffPrompt(p, nav, drv, timeline, pr), path.join(dir, 'work'))).trim(); }
    catch (e) { verdict = `(${nav.label} could not sign off: ${e.message.split('\n')[0]})`; }
    const agreed = END.test(verdict);
    add('signoff', verdict.replace(END, '').trim(), { agreed });
    if (agreed) { result = 'done: tests pass and both agree'; break; }
    next = `The hidden tests pass, but ${nav.label} doesn't sign off yet:\n\n${verdict}\n\nDeal with it, or say why it's fine as it is.`;
  }
  return { result, timeline, looks, seconds: Math.round(at()) };
}

function markdown(p, nav, s) {
  const cuts = s.timeline.filter(e => e.kind === 'cut').length, helps = s.timeline.filter(e => e.kind === 'help').length;
  const checks = s.timeline.filter(e => e.kind === 'check');
  return [
    `# ${p.title || 'The Pair'}`, '',
    `Driver: Codex ${p.driver.model || '(CLI default)'} · Navigator: ${nav.label} ${nav.model || '(CLI default)'}`, '',
    `**Result:** ${s.result} · ${Math.round(s.seconds / 60)} min · ${s.looks} navigator looks · ${cuts} cut-ins · ${helps} help requests · test runs: ${checks.map(c => c.pass ? 'pass' : 'fail').join(', ') || 'none'}`, '',
    '## Task', '', p.task, '',
    '## Session', '',
    ...s.timeline.filter(e => e.kind !== 'think').map(e => [`**${Math.round(e.at)}s · ${WHO[e.kind] || e.kind}**`, '', /\n/.test(e.text) && ['run', 'check', 'edit'].includes(e.kind) ? '```\n' + e.text + '\n```' : e.text, ''].join('\n')),
  ].join('\n');
}

async function main() {
  const file = process.argv[2];
  if (!file) usage();
  const base = path.dirname(path.resolve(file));
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rel = f => f && path.resolve(base, f);
  const p = {
    title: raw.title || 'The Pair', task: String(raw.task || '').trim(),
    starter: rel(raw.starter), tests: rel(raw.tests),
    proof: Array.isArray(raw.proof) && raw.proof.length ? raw.proof : null,
    proof_wrap: Array.isArray(raw.proof_wrap) && raw.proof_wrap.length ? raw.proof_wrap : PROOF_WRAP,
    look_secs: raw.look_secs || 45, max_looks: raw.max_looks || 40, max_rounds: raw.max_rounds || 6, max_minutes: raw.max_minutes || 40,
    driver: { model: 'gpt-6-luna', start: DRIVER_START, resume: DRIVER_RESUME, env: ['OPENAI_API_KEY', 'CODEX_HOME'], ...(raw.driver || {}) },
  };
  if (!p.task) throw new Error('pair.json needs a "task".');
  if (!p.proof) throw new Error('pair.json needs "proof", the command that runs the hidden tests, e.g. ["node", "--test", "hidden-tests/x.test.js"].');
  if (!p.tests || !fs.existsSync(p.tests)) throw new Error('pair.json needs "tests", a folder of hidden tests.');
  // The driver must stay sandboxed: refuse any command that would loosen it.
  for (const c of [p.driver.start, p.driver.resume]) {
    if (c.some(a => /dangerously|danger-full-access|bypass/i.test(a))) throw new Error('The driver command may not loosen the sandbox.');
  }
  const cfg = loadConfig();
  const nav = cfg.agents.find(a => a.id === (raw.navigator || 'claude'));
  if (!nav || !nav.headless) throw new Error(`No headless agent "${raw.navigator || 'claude'}" in agents.json.`);

  const dir = path.join(HOME_DIR, 'pairs', `${stamp()}-${crypto.randomBytes(2).toString('hex')}`);
  fs.mkdirSync(path.join(dir, 'work'), { recursive: true });
  if (p.starter) copyDir(p.starter, path.join(dir, 'work'));
  console.log(`The Pair: ${dir}`);
  const s = await session(p, dir, nav);
  fs.writeFileSync(path.join(dir, 'episode.md'), markdown(p, nav, s));
  console.log(`\n${s.result} · ${s.seconds}s · ${s.looks} looks\n${path.join(dir, 'episode.md')}`);
}

module.exports = { describe, sessionOf, HELP, SILENT, END, navPrompt, driverBrief };
if (require.main === module) main().catch(e => { console.error(`pair: ${e.message}`); process.exit(1); });
