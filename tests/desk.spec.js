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
const broke = ${JSON.stringify(path.join(side, 'break-done'))};
if (process.env.FAKE_BREAK === id && !fs.existsSync(broke)) { fs.writeFileSync(broke, ''); fs.writeFileSync('tokenize.js', 'module.exports = { tokenize: () => [] };\\n'); }
const said = process.env.FAKE_SAY_STUCK === id ? 'STUCK: no, the task is done. Wrote ' + file + '.' : 'Wrote ' + file + '.';
console.log(JSON.stringify({ type: 'result', is_error: false, result: said, total_cost_usd: 0.1 }));
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

    // A git snapshot of work/ per event, outside work/, by the worker named.
    const snaps = execFileSync('git', ['--git-dir', path.join(d.dir, 'snap.git'), 'log', '--format=%an|%s'], { encoding: 'utf8' }).trim().split('\n');
    const nEvents = fs.readFileSync(path.join(d.dir, 'events.jsonl'), 'utf8').trim().split('\n').length;
    expect(snaps.length).toBe(nEvents);
    expect(snaps.some(s => /^w[12]\|leased t1 w[12]$/.test(s))).toBe(true);
    expect(snaps.some(s => /^w[12]\|accepted t6 w[12]$/.test(s))).toBe(true);
    expect(fs.existsSync(path.join(d.dir, 'work', '.git'))).toBe(false);
    const files = execFileSync('git', ['--git-dir', path.join(d.dir, 'snap.git'), 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' });
    expect(files).toContain('sheet.js');

    // A task that needs others is never lent before they are accepted.
    const evs = fs.readFileSync(path.join(d.dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const at = (ev, task) => evs.findIndex(e => e.ev === ev && e.task === task);
    expect(at('leased', 't4')).toBeGreaterThan(at('accepted', 't1'));
    expect(at('leased', 't6')).toBeGreaterThan(at('accepted', 't5'));
    expect(new Set(evs.filter(e => e.ev === 'leased').map(e => e.worker))).toEqual(new Set(['w1', 'w2']));

    // The agent: file tools only, in work/, without the GitHub token; it sees the
    // judging test and the board, not the checks folder.
    const seen = JSON.parse(fs.readFileSync(path.join(d.side, 'args.json'), 'utf8'));
    expect(seen.args).toEqual(['-p', '--model', 'claude-opus-5-5', '--max-turns', '40', '--tools', 'Read,Write,Edit,Glob,Grep', '--permission-mode', 'acceptEdits', '--strict-mcp-config', '--safe-mode', '--output-format', 'json', '--']);
    expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(path.join(d.dir, 'work')));
    expect(seen.gh).toBe(null);
    const prompts = fs.readFileSync(path.join(d.side, 'prompts.txt'), 'utf8');
    expect(prompts).toContain("assert.deepStrictEqual(tokenize('SUM(A1:B2, 3.5) * -c7')");
    expect(prompts).toContain('- t1 "Tokenizer (tokenize.js)": done');

    const report = execFileSync('node', [DESK, 'report', d.dir], { encoding: 'utf8' });
    expect(report).toMatch(/^Run: .+, first event \d{4}-/);
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

test('round 2: the KPI-tree check accepts a complete team-level tree and names what is wrong with a bad one', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kpi-'));
  const check = path.join(ROOT, 'examples', 'desk', 'round2', 'checks', 'kpi-tree.check.js');
  const run = () => { try { return { ok: true, out: execFileSync('node', [check], { cwd: work, encoding: 'utf8' }) }; } catch (e) { return { ok: false, out: String(e.stdout) }; } };
  const ind = n => ({ name: n, measure: 'median days', data: 'issue tracker', better: 'down', gaming: 'splitting tickets', level: 'team' });
  const good = { top: { name: 'Lead time', why: 'speed to users', measure: 'median days idea to production', better: 'down' },
    drivers: ['Flow', 'Quality', 'Focus'].map((d, i) => ({ name: d, why: 'matters', indicators: [ind(`i${i}a`), ind(`i${i}b`)] })) };
  expect(run()).toMatchObject({ ok: false });
  fs.writeFileSync(path.join(work, 'kpi-tree.json'), JSON.stringify(good));
  expect(run()).toEqual({ ok: true, out: 'kpi-tree.json accepted: 3 drivers, 6 indicators.\n' });
  const bad = structuredClone(good);
  bad.drivers[0].indicators[0].level = 'person';
  bad.drivers.pop();
  fs.writeFileSync(path.join(work, 'kpi-tree.json'), JSON.stringify(bad));
  const r = run();
  expect(r.ok).toBe(false);
  expect(r.out).toContain('there must be 3 to 5 drivers, not 2');
  expect(r.out).toContain('drivers[0].indicators[0].level must be "team"');
  // Every round-2 task points at a spec that exists in the round folder.
  const goal = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'desk', 'round2', 'goal.json'), 'utf8'));
  for (const t of goal.tasks) expect(fs.existsSync(path.join(ROOT, 'examples', 'desk', 'round2', t.spec))).toBe(true);
});

test('recheck_done: work that breaks something already accepted sends it back, and the report counts it', async () => {
  const d = await desk({ recheck_done: true });
  try {
    await d.work('solo', { FAKE_BREAK: 't2' });
    const evs = fs.readFileSync(path.join(d.dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(evs.find(e => e.ev === 'broken')).toMatchObject({ task: 't1', after: 't2', worker: 'solo' });
    const board = (await d.call('GET', '/board')).json;
    expect(board.tasks.map(t => t.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
    const prompts = fs.readFileSync(path.join(d.side, 'prompts.txt'), 'utf8');
    expect(prompts).toContain('Was accepted, but fails now (after t2 by solo was accepted)');
    expect(execFileSync('node', [DESK, 'report', d.dir], { encoding: 'utf8' })).toContain('Accepted work broken later by other work: 1 times');
  } finally { d.stop(); }
});

test('JSON Schema round: every suite file is judged once, needs never loop, the official tests are copied for reading, and the runner judges', () => {
  const R = path.join(ROOT, 'examples', 'desk', 'jsonschema');
  const goal = JSON.parse(fs.readFileSync(path.join(R, 'goal.json'), 'utf8'));
  const files = fs.readdirSync(path.join(R, 'suite')).filter(f => f.endsWith('.json')).sort();
  const judged = goal.tasks.filter(t => t.id !== 'all').flatMap(t => t.check.slice(2).filter(a => !a.startsWith('--'))).sort();
  expect(judged).toEqual(files);
  // Every task can be lent once the tasks it needs are done: no cycles, no unknown ids.
  const done = new Set();
  for (let round = 0; round < goal.tasks.length; round++) for (const t of goal.tasks) if (t.needs.every(n => done.has(n))) done.add(t.id);
  expect(done.size).toBe(goal.tasks.length);
  for (const t of goal.tasks) expect(fs.existsSync(path.join(R, t.spec))).toBe(true);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'js-'));
  const dir = path.join(tmp, 'run');
  execFileSync('node', [DESK, 'init', dir, '--from', R]);
  expect(fs.readdirSync(path.join(dir, 'work', 'tests-official')).filter(f => f.endsWith('.json')).sort()).toEqual(files);
  const run = (...a) => { try { return { ok: true, out: execFileSync('node', ['../checks/run-suite.js', ...a], { cwd: path.join(dir, 'work'), encoding: 'utf8' }) }; } catch (e) { return { ok: false, out: String(e.stdout) }; } };
  expect(run('boolean_schema.json')).toMatchObject({ ok: false, out: expect.stringContaining('validate.js could not be loaded') });
  fs.writeFileSync(path.join(dir, 'work', 'validate.js'), 'module.exports = { validate: schema => schema !== false };\n');
  expect(run('boolean_schema.json')).toEqual({ ok: true, out: '18 of 18 tests pass.\n' });
  const bad = run('type.json');
  expect(bad.ok).toBe(false);
  expect(bad.out).toMatch(/^\d+ of 80 tests pass\.\ntype\.json \| /);
  expect(execFileSync('node', [DESK, 'report', dir], { encoding: 'utf8' })).toMatch(/Final check: \d+ of 1314 tests pass\./);
});

test('JSON Schema mini round: a closed subset with its own suite files, a $2 cap and a final task over all of them', () => {
  const M = path.join(ROOT, 'examples', 'desk', 'jsonschema-mini');
  const goal = JSON.parse(fs.readFileSync(path.join(M, 'goal.json'), 'utf8'));
  expect(goal.settings.budget_usd).toBe(2);
  const ids = goal.tasks.map(t => t.id);
  for (const t of goal.tasks) for (const n of t.needs) expect(ids).toContain(n);
  const judged = goal.tasks.filter(t => t.id !== 'all').flatMap(t => t.check.slice(2).filter(a => !a.startsWith('--'))).sort();
  expect(fs.readdirSync(path.join(M, 'suite')).filter(f => f.endsWith('.json')).sort()).toEqual(judged);
  for (const t of goal.tasks) expect(fs.existsSync(path.join(M, t.spec))).toBe(true);
  expect(goal.tasks.find(t => t.id === 'all').needs.sort()).toEqual(ids.filter(i => i !== 'all').sort());
  // enum's tests also use "properties", which no mini task owns: those cases
  // are left out (once a task stuck on them after three honest tries).
  const skipOf = id => goal.tasks.find(t => t.id === id).check.find(a => a.startsWith('--skip-keywords=')).slice(16).split(',');
  expect(skipOf('enum')).toContain('properties');
  expect(skipOf('all')).toContain('properties');
  expect(skipOf('enum')).not.toContain('enum');
});

test('a task with a check is judged whatever the agent answers, even "STUCK: no, it is done"', async () => {
  const d = await desk();
  try {
    await d.work('solo', { FAKE_SAY_STUCK: 't1' });
    const board = (await d.call('GET', '/board')).json;
    expect(board.tasks.find(t => t.id === 't1')).toMatchObject({ status: 'done', attempts: 1 });
    const prompts = fs.readFileSync(path.join(d.side, 'prompts.txt'), 'utf8');
    expect(prompts).toContain('The check judges your files whatever you answer.');
    expect(prompts).not.toContain('start your answer with STUCK:');
  } finally { d.stop(); }
});

test('a worker started before the desk waits for it instead of failing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'late-'));
  const dir = path.join(tmp, 'run');
  execFileSync('node', [DESK, 'init', dir, '--from', path.join(ROOT, 'examples', 'desk', 'round1')]);
  const goalFile = path.join(dir, 'goal.json');
  fs.writeFileSync(goalFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(goalFile, 'utf8')), settings: { budget_usd: 0 } }));
  const port = nextPort++;
  const worker = promisify(execFile)('node', [WORKER, dir, '--name', 'early', '--desk', `http://127.0.0.1:${port}`], { env: { ...process.env, DESK_RETRY_MS: '200' }, encoding: 'utf8' });
  await sleep(500);
  const server = spawn('node', [DESK, 'serve', dir, '--port', String(port)], { stdio: 'ignore' });
  try {
    expect((await worker).stdout).toContain('early: stopping, the desk says budget.');
  } finally { server.kill(); }
});

test('table: one row per run of a series and the mean time per side', async () => {
  const d = await desk();
  try {
    await d.work('w1');
  } finally { d.stop(); }
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-runs-'));
  for (const name of ['s-gruppo-1', 's-solo-1', 'other-solo-1']) fs.cpSync(d.dir, path.join(runs, name), { recursive: true });
  fs.writeFileSync(path.join(runs, 's-gruppo-1', 'work', 'README.md'), '# how files plug in\n');
  const out = execFileSync('node', [DESK, 'table', runs, 's'], { encoding: 'utf8' });
  const lines = out.split('\n');
  expect(lines[0]).toMatch(/^run\s+workers\s+done\s+leases\s+rejected/);
  expect(lines[1]).toMatch(/^s-gruppo-1\s+1\s+6\/6\s+6\s+0\s+0\s+0\s+\d+\.\d\s+0\.60\s+yes/);
  expect(lines[2]).toMatch(/^s-solo-1\s+1\s+6\/6\s+6\s+0\s+0\s+0\s+\d+\.\d\s+0\.60\s+no/);
  expect(out).not.toContain('other-solo-1');
  expect(out).toMatch(/group: 1 runs, mean \d+\.\d min/);
  expect(out).toMatch(/solo: 1 runs, mean \d+\.\d min .*mean \$0\.60/);
});

test('JSON Schema mini plain: the same round with a goal that says nothing about how to coordinate', () => {
  const mini = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'desk', 'jsonschema-mini', 'goal.json'), 'utf8'));
  const plain = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'desk', 'jsonschema-mini-plain', 'goal.json'), 'utf8'));
  expect(mini.goal).toContain('README');
  expect(plain.goal).not.toMatch(/README|agree|structure|Several workers/);
  expect(plain.tasks).toEqual(mini.tasks);
  expect(plain.settings).toEqual(mini.settings);
});

test('overlap round: contract tasks open from the start, and every keyword is judged in the contracts validate.js offers', () => {
  const goal = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'desk', 'jsonschema-overlap', 'goal.json'), 'utf8'));
  const byId = Object.fromEntries(goal.tasks.map(t => [t.id, t]));
  for (const id of ['errors', 'strict', 'compile']) {
    expect(byId[id].needs).toEqual(['core']);
    expect(byId[id].check).toContain(`--require=${id}`);
    expect(byId[id].check).toContain('--only-working');
  }
  expect(byId.enum.check).toContain('--contracts');
  expect(byId.all.needs).toEqual(expect.arrayContaining(['errors', 'strict', 'compile', 'enum']));
  expect(goal.settings.final_check).toContain('--require=errors,strict,compile');
  expect(goal.goal).not.toMatch(/README|agree|Several workers/);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-overlap-'));
  const dir = path.join(tmp, 'run');
  execFileSync('node', [DESK, 'init', dir, '--from', path.join(ROOT, 'examples', 'desk', 'jsonschema-overlap')]);
  const work = path.join(dir, 'work');
  const ref = fs.readFileSync(path.join(__dirname, 'fixtures', 'desk-jsonschema-ref', 'validate.js'), 'utf8');
  const judge = id => { try { return { ok: true, out: execFileSync(byId[id].check[0], byId[id].check.slice(1), { cwd: work, encoding: 'utf8' }) }; } catch (e) { return { ok: false, out: String(e.stdout) }; } };

  // The reference offers all three contracts and passes every task.
  fs.writeFileSync(path.join(work, 'validate.js'), ref);
  for (const t of goal.tasks) expect(judge(t.id).ok, `${t.id}: ${judge(t.id).out}`).toBe(true);
  expect(judge('enum').out).toContain('Contracts judged: errors, strict, compile');

  // Without compile: the compile task fails, the keyword tasks do not.
  fs.writeFileSync(path.join(work, 'validate.js'), ref.replace('module.exports = { validate, compile };', 'module.exports = { validate };'));
  expect(judge('compile').ok).toBe(false);
  expect(judge('compile').out).toContain('does not offer');
  expect(judge('enum').ok).toBe(true);

  // A keyword that ignores the errors contract fails its own task once errors exists.
  fs.writeFileSync(path.join(work, 'validate.js'), ref.replace("if (out) out.push({ keyword: k, instancePath: path }); else return false;", "if (out && k !== 'enum') out.push({ keyword: k, instancePath: path }); else if (!out) return false;"));
  expect(judge('enum').ok).toBe(false);
  expect(judge('enum').out).toContain('no error names a keyword');
  expect(judge('type').ok).toBe(true);

  // A contract task judges only cases plain validate already gets right.
  fs.writeFileSync(path.join(work, 'validate.js'), ref.replace('enum: (v, d) => v.some(x => equal(x, d)),', 'enum: () => true,'));
  expect(judge('errors').ok).toBe(true);
  expect(judge('errors').out).toMatch(/cases plain validate does not get right yet/);
});
