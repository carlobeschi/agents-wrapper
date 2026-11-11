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
