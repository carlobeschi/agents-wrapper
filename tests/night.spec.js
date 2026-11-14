// @ts-check
// night.js: a queue of stand-in jobs (ok, failing, off, too slow), run twice.
const { test, expect } = require('@playwright/test');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nextStop, loadQueue, expandHome } = require('../night');

const run = promisify(execFile);
const ROOT = path.join(__dirname, '..');

test('the stop time is the next HH:MM, today or tomorrow', () => {
  const now = new Date(2026, 10, 11, 19, 0);
  expect(nextStop('07:15', now)).toEqual(new Date(2026, 10, 12, 7, 15));
  expect(nextStop('23:30', now)).toEqual(new Date(2026, 10, 11, 23, 30));
  expect(() => nextStop('7.15', now)).toThrow();
});

test('home folder in arguments, queue checks', () => {
  expect(expandHome('~/x')).toBe(path.join(os.homedir(), 'x'));
  expect(expandHome('--out=~/x')).toBe('--out=' + path.join(os.homedir(), 'x'));
  expect(expandHome('a~/b')).toBe('a~/b');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'night-q-'));
  const f = path.join(dir, 'q.json');
  fs.writeFileSync(f, JSON.stringify({ jobs: [{ name: 'a', cmd: ['node'] }, { name: 'a', cmd: ['node'] }] }));
  expect(() => loadQueue(f)).toThrow(/twice/);
  fs.writeFileSync(f, JSON.stringify({ jobs: [{ name: 'a b', cmd: ['node'] }] }));
  expect(() => loadQueue(f)).toThrow(/name/);
});

test('the example queue is valid', () => {
  const q = loadQueue(path.join(ROOT, 'examples', 'night', 'queue.json'));
  expect(q.jobs.length).toBeGreaterThan(0);
  // Tonight's order (14 Nov): study 15 phase 0, then rules-author, then study-15a, and both Claude jobs fit the budget.
  const at = n => q.jobs.findIndex(j => j.name === n);
  expect(at('study15-phase0-qwen-2')).toBeLessThan(at('rules-author'));
  expect(at('rules-author')).toBeLessThan(at('study-15a'));
  expect(q.jobs[at('rules-author')].claude_calls + q.jobs[at('study-15a')].claude_calls).toBeLessThanOrEqual(q.claude_budget);
});

test('jobs run in order, done ones are kept, a slow one is stopped', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'night-home-'));
  const q = path.join(home, 'queue.json');
  fs.writeFileSync(q, JSON.stringify({
    min_minutes: 0,
    jobs: [
      { name: 'ok', cmd: ['node', '-e', 'console.log("hello from ok")'] },
      { name: 'fails', cmd: ['node', '-e', 'process.exit(3)'] },
      { name: 'off', cmd: ['node', '-e', ''], enabled: false },
      { name: 'slow', cmd: ['node', '-e', 'setTimeout(() => {}, 60000)'] },
    ],
  }));
  const env = { ...process.env, AGENT_DISPATCH_HOME: home };
  const stopAt = () => new Date(Date.now() + 4000).toISOString();
  await run(process.execPath, ['night.js', q, '--no-pull', '--stop-at', stopAt()], { cwd: ROOT, env, timeout: 60000 });

  const night = path.join(home, 'night');
  const state = JSON.parse(fs.readFileSync(path.join(night, 'state.json'), 'utf8'));
  expect(Object.keys(state.done)).toEqual(['ok']);
  const sum = fs.readFileSync(path.join(night, 'last-summary.md'), 'utf8');
  expect(sum).toMatch(/\| ok \| ok \|/);
  expect(sum).toMatch(/\| fails \| failed \(exit 3\) \|/);
  expect(sum).toMatch(/\| off \| off \|/);
  expect(sum).toMatch(/\| slow \| stopped \|/);
  expect(sum).toContain('hello from ok');

  await run(process.execPath, ['night.js', q, '--no-pull', '--stop-at', stopAt()], { cwd: ROOT, env, timeout: 60000 });
  const again = fs.readFileSync(path.join(night, 'last-summary.md'), 'utf8');
  expect(again).toMatch(/\| ok \| done before \|/);
  expect(again).toMatch(/\| fails \| failed/);

  const { stdout } = await run(process.execPath, ['night.js', q, '--list'], { cwd: ROOT, env });
  expect(stdout).toMatch(/ok\s+done/);
  expect(stdout).toMatch(/off\s+off/);
});

test('a job that exits 0 with many failed calls is suspect, counted on this night only', () => {
  const { failedCalls } = require('../night');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'night-f-'));
  const f = path.join(dir, 'job.log');
  fs.writeFileSync(f, ['---- Wed', '$ node x.js', ...Array(9).fill('  ✗ Claude Code 1, 01: exit 1'), '---- Thu', '$ node x.js', '  ✓ a: 10 chars', '  ✓ b: 10 chars', '  ✗ c: exit 1', ''].join('\n'));
  expect(failedCalls(f)).toEqual({ failed: 1, ok: 2, suspect: false });
  fs.appendFileSync(f, ['---- Fri', '$ node x.js', '  ✓ a: 1 chars', ...Array(6).fill('  ✗ Claude Code 1, 02: exit 1'), '  ↻ 03: exit 1, retrying', '---- time is up, stopping', ''].join('\n'));
  expect(failedCalls(f)).toEqual({ failed: 6, ok: 1, suspect: true });
});

test('Claude budget: a job that would go over it waits for the next night, the status lines say why', async () => {
  const { fitsBudget, statusLine } = require('../night');
  expect(fitsBudget(null, 900, 500)).toBe(true);
  expect(fitsBudget(100, 0, 500)).toBe(true); // the night's first Claude job, however big
  expect(fitsBudget(100, 60, 50)).toBe(false);
  expect(fitsBudget(100, 60, 40)).toBe(true);
  expect(fitsBudget(100, 100, 0)).toBe(true);
  expect(statusLine({ name: 'a', result: 'ok', ms: 120000, calls: 3, est: 2 })).toBe('- **a**: ok · 2 min · Claude 3 calls (expected 2)');

  // A stand-in "claude" (any command named claude counts) and a job that calls it three times through motion.run.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'night-b-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "fine"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [{ id: 'claude', label: 'Claude Code', headless: [path.join(bin, 'claude'), '{prompt}'] }] }));
  const job = path.join(home, 'job.js');
  fs.writeFileSync(job, `const { run } = require(${JSON.stringify(path.join(ROOT, 'motion.js'))});
const { loadConfig } = require(${JSON.stringify(path.join(ROOT, 'config.js'))});
const a = loadConfig().agents[0];
(async () => { for (const i of [1, 2, 3]) await run(${JSON.stringify(home)}, 's' + i, a, 'hi', ${JSON.stringify(home)}); })();`);
  const q = path.join(home, 'queue.json');
  fs.writeFileSync(q, JSON.stringify({
    min_minutes: 0, claude_budget: 5,
    jobs: [
      { name: 'local', cmd: ['node', '-e', ''], claude_calls: 0 },
      { name: 'first', cmd: ['node', job], claude_calls: 4 },
      { name: 'big', cmd: ['node', job], claude_calls: 3 },
      { name: 'small', cmd: ['node', job], claude_calls: 2 },
      { name: 'after', cmd: ['node', '-e', ''], claude_calls: 2 },
      { name: 'none', cmd: ['node', '-e', ''], claude_calls: 0 },
    ],
  }));
  const env = { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json') };
  await run(process.execPath, ['night.js', q, '--no-pull', '--stop-at', new Date(Date.now() + 60000).toISOString()], { cwd: ROOT, env, timeout: 60000 });
  const sum = fs.readFileSync(path.join(home, 'night', 'last-summary.md'), 'utf8');
  // first: 3 used; big (3) doesn't fit, small (2) does and uses 3 more; after (2) no longer fits.
  expect(sum).toContain('Claude calls tonight: 6 of a budget of 5.');
  expect(sum).toContain('- **local**: ok');
  expect(sum).toMatch(/- \*\*first\*\*: ok · .* · Claude 3 calls \(expected 4\)/);
  expect(sum).toContain('- **big**: skipped, over the Claude budget (expects 3 calls, 2 of 5 left), next night · expects 3 Claude calls');
  expect(sum).toMatch(/- \*\*small\*\*: ok · .* · Claude 3 calls \(expected 2\)/);
  expect(sum).toContain('- **after**: skipped, over the Claude budget (expects 2 calls, 0 of 5 left), next night');
  expect(sum).toContain('- **none**: ok');
  expect(sum).toMatch(/\| first \| ok \| .* \| 3 \|/);
  const state = JSON.parse(fs.readFileSync(path.join(home, 'night', 'state.json'), 'utf8'));
  expect(Object.keys(state.done)).toEqual(['local', 'first', 'small', 'none']);

  fs.writeFileSync(q, JSON.stringify({ claude_budget: 5, jobs: [{ name: 'x', cmd: ['node'] }] }));
  expect(() => loadQueue(q)).toThrow(/claude_calls/);
});
