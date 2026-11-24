// @ts-check
// desk.js + desk-worker.js: agents borrow tasks from a shared desk. A fake
// `claude` copies the reference solution (tests/fixtures/desk-ref) for its
// task, so the real checks of round 1 judge real files. No model is called.
const { test, expect } = require('@playwright/test');
const { spawn, execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DESK = path.join(ROOT, 'desk.js'), WORKER = path.join(ROOT, 'desk-worker.js');
const REF = path.join(__dirname, 'fixtures', 'desk-ref');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let nextPort = 18790 + Math.floor(Math.random() * 500);

async function desk(settings = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-'));
  const dir = path.join(tmp, 'run'), side = path.join(tmp, 'side');
  fs.mkdirSync(side);
  execFileSync('node', [DESK, 'init', dir, '--from', path.join(ROOT, 'examples', 'desk', 'round1')]);
  const goalFile = path.join(dir, 'goal.json');
  const goal = JSON.parse(fs.readFileSync(goalFile, 'utf8'));
  fs.writeFileSync(goalFile, JSON.stringify({ ...goal, settings: { ...goal.settings, ...settings } }));
  // Fake Claude Code: finds its task in the prompt, records the prompt, and
  // copies the reference file. With FAKE_BAD_ONCE=t1 its first t1 is broken.
  const claude = path.join(side, 'claude.js');
  fs.writeFileSync(claude, `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const prompt = process.argv[process.argv.length - 1];
const id = prompt.match(/Your task: (t\\d)/)[1];
fs.appendFileSync(${JSON.stringify(path.join(side, 'prompts.txt'))}, prompt + '\\n=====\\n');
fs.writeFileSync(${JSON.stringify(path.join(side, 'args.json'))}, JSON.stringify({ args: process.argv.slice(2, -1), cwd: process.cwd(), gh: process.env.GH_TOKEN || null }));
const file = { t1: 'tokenize', t2: 'cells', t3: 'functions', t4: 'parse', t5: 'evaluate', t6: 'sheet' }[id] + '.js';
const flag = ${JSON.stringify(path.join(side, 'bad-done'))};
if (process.env.FAKE_BAD_ONCE === id && !fs.existsSync(flag)) { fs.writeFileSync(flag, ''); fs.writeFileSync(file, 'module.exports = { tokenize: () => [] };\\n'); }
else fs.copyFileSync(path.join(${JSON.stringify(REF)}, file), file);
console.log(JSON.stringify({ type: 'result', is_error: false, result: 'Wrote ' + file + '.', total_cost_usd: 0.1 }));
`, { mode: 0o755 });
  const port = nextPort++;
  const server = spawn('node', [DESK, 'serve', dir, '--port', String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(res => server.stdout.once('data', res));
  const url = `http://127.0.0.1:${port}`;
  const env = { ...process.env, DESK_CLAUDE: claude, DESK_POLL_MS: '100', DESK_IDLE_MS: '20000', GH_TOKEN: 'ghs-test' };
  const work = (name, extra = {}) => promisify(execFile)('node', [WORKER, dir, '--name', name, '--desk', url], { env: { ...env, ...extra }, encoding: 'utf8' });
  const call = async (method, route, payload) => {
    const r = await fetch(url + route, { method, headers: { 'content-type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
    return { code: r.status, json: await r.json().catch(() => ({})) };
  };
  return { dir, side, url, work, call, stop: () => server.kill() };
}

test('two workers borrow every task in dependency order and the checks accept the work', async () => {
  const d = await desk();
  try {
    const [a, b] = await Promise.all([d.work('w1'), d.work('w2')]);
    expect(a.stdout + b.stdout).toContain('the desk says done');
    const board = (await d.call('GET', '/board')).json;
    expect(board.tasks.map(t => t.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
    expect(board.spent_usd).toBeCloseTo(0.6);

    // A task that needs others is never lent before they are accepted.
    const evs = fs.readFileSync(path.join(d.dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const at = (ev, task) => evs.findIndex(e => e.ev === ev && e.task === task);
    expect(at('leased', 't4')).toBeGreaterThan(at('accepted', 't1'));
    expect(at('leased', 't6')).toBeGreaterThan(at('accepted', 't5'));
    expect(new Set(evs.filter(e => e.ev === 'leased').map(e => e.worker))).toEqual(new Set(['w1', 'w2']));

    // The agent: file tools only, in work/, without the GitHub token; it sees the
    // judging test and the board, not the checks folder.
    const seen = JSON.parse(fs.readFileSync(path.join(d.side, 'args.json'), 'utf8'));
    expect(seen.args).toEqual(['-p', '--model', 'claude-opus-5-5', '--max-turns', '40', '--tools', 'Read,Write,Edit,Glob,Grep', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--output-format', 'json', '--']);
    expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(path.join(d.dir, 'work')));
    expect(seen.gh).toBe(null);
    const prompts = fs.readFileSync(path.join(d.side, 'prompts.txt'), 'utf8');
    expect(prompts).toContain("assert.deepStrictEqual(tokenize('SUM(A1:B2, 3.5) * -c7')");
    expect(prompts).toContain('- t1 "Tokenizer (tokenize.js)": done');

    const report = execFileSync('node', [DESK, 'report', d.dir], { encoding: 'utf8' });
    expect(report).toContain('Tasks: 6 (done 6, waiting for review 0, stuck 0, open 0)');
    expect(report).toContain('accepted 6, rejected 0');
    expect(report).toContain('Spent about $0.60');
  } finally { d.stop(); }
});

test('work the check rejects goes back with the failing output, and the next try sees it', async () => {
  const d = await desk();
  try {
    await d.work('solo', { FAKE_BAD_ONCE: 't1' });
    const board = (await d.call('GET', '/board')).json;
    expect(board.tasks.find(t => t.id === 't1')).toMatchObject({ status: 'done', attempts: 2 });
    const second = fs.readFileSync(path.join(d.side, 'prompts.txt'), 'utf8').split('=====').find(p => /Your task: t1/.test(p) && /Rejected by the check/.test(p));
    expect(second).toContain('[check] Rejected by the check:');
    expect(execFileSync('node', [DESK, 'report', d.dir], { encoding: 'utf8' })).toContain('accepted 6, rejected 1');
  } finally { d.stop(); }
});

test('a lease that is not renewed runs out, the task goes to someone else, and late work is refused but paid for', async () => {
  const d = await desk({ lease_seconds: 1 });
  try {
    const first = (await d.call('GET', '/next?worker=slow')).json;
    expect(first).toMatchObject({ status: 'task', task: { id: 't1' } });
    await sleep(1300);
    const again = (await d.call('GET', '/next?worker=fast')).json;
    expect(again.task.id).toBe('t1');
    const late = await d.call('POST', '/release', { lease: first.lease, reason: 'submitted', cost_usd: 0.5 });
    expect(late.code).toBe(410);
    const board = (await d.call('GET', '/board')).json;
    expect(board.spent_usd).toBe(0.5);
    expect(board.tasks[0]).toMatchObject({ status: 'leased', holder: 'fast' });
    expect(fs.readFileSync(path.join(d.dir, 'events.jsonl'), 'utf8')).toContain('"ev":"expired","task":"t1","worker":"slow"');
  } finally { d.stop(); }
});

test('people add tasks, comment and review; the budget stops the lending; the board is a page', async () => {
  const d = await desk({ budget_usd: 0.15 });
  try {
    const added = await d.call('POST', '/tasks', { title: 'Write a README for the engine', detail: 'Two paragraphs.', by: 'Ann', check: ['rm', '-rf', '/'] });
    expect(added.json.id).toBe('p1');
    await d.call('POST', '/comment', { text: 'Keep it short', task: 'p1', by: 'Bea' });
    await d.call('POST', '/comment', { text: 'Hello all', by: 'Bea' });
    expect((await d.call('POST', '/comment', { text: 'x', task: 'nope' })).code).toBe(404);

    // Lend everything that is free; p1 has no check, so it waits for a person.
    const t1 = (await d.call('GET', '/next?worker=w')).json;
    await d.call('POST', '/release', { lease: t1.lease, reason: 'stuck', note: 'STUCK: no time', cost_usd: 0.05 });
    expect((await d.call('GET', '/board')).json.tasks[0].status).toBe('open');
    const leases = [];
    for (let i = 0; i < 4; i++) leases.push((await d.call('GET', '/next?worker=w')).json);
    const p1 = leases.find(l => l.task && l.task.id === 'p1');
    expect(p1.task.notes.map(n => n.text)).toContain('Keep it short');
    expect(p1.comments.map(c => c.text)).toContain('Hello all');
    expect((await d.call('POST', '/release', { lease: p1.lease, reason: 'submitted', cost_usd: 0.05 })).json.status).toBe('review');
    expect((await d.call('POST', '/review', { task: 'p1', verdict: 'accept', by: 'Ann' })).json.status).toBe('done');
    expect((await d.call('POST', '/review', { task: 'p1', verdict: 'accept' })).code).toBe(409);
    // The added task never got a check command.
    expect(JSON.parse(fs.readFileSync(path.join(d.dir, 'desk.json'), 'utf8')).tasks.find(t => t.id === 'p1').check).toBeUndefined();

    await d.call('POST', '/release', { lease: leases[0].lease, reason: 'stuck', cost_usd: 0.1 });
    expect((await d.call('GET', '/next?worker=w')).json.status).toBe('budget');

    const html = await (await fetch(d.url + '/')).text();
    expect(html).toContain('Build a tiny spreadsheet engine');
    expect(html).toContain('Write a README for the engine');
  } finally { d.stop(); }
});

test('the Open WebUI tool reads the board and adds tasks and comments', async () => {
  let py = true;
  try { execFileSync('python3', ['--version']); } catch { py = false; }
  test.skip(!py, 'python3 not installed');
  const d = await desk();
  try {
    const script = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("tool", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
t = m.Tools(); t.valves.desk_url = sys.argv[2]
print(t.desk_add_task("Summarise the open questions", "One page.", __user__={"name": "Ann"}))
print(t.desk_comment("Looks good so far", "t1", __user__={"name": "Bea"}))
print(t.desk_review("t1", "accept"))
print(t.desk_board())
`;
    const out = execFileSync('python3', ['-I', '-c', script, path.join(ROOT, 'examples', 'desk', 'openwebui_desk_tool.py'), d.url], { encoding: 'utf8' });
    expect(out).toContain('Added task p1.');
    expect(out).toContain('Comment saved on the desk.');
    expect(out).toContain('that task is not waiting for review');
    expect(out).toContain('Goal: Build a tiny spreadsheet engine');
    expect(out).toContain('- p1 Summarise the open questions: open (tries 0)');
  } finally { d.stop(); }
});
