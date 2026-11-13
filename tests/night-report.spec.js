// @ts-check
// night-report.js: the summary goes to a private clone, redacted; night.sh runs once at a time.
const { test, expect } = require('@playwright/test');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildReport, stampOf } = require('../night-report');

const run = promisify(execFile);
const ROOT = path.join(__dirname, '..');

test('the report puts the launcher note first and redacts', () => {
  const text = buildReport({ summary: '# Night run 2026-11-13_210000-1\n\nlog in /home/ada/x', launcher: 'run 2026-11-13_210000\non battery (40%)' },
    t => t.replaceAll('/home/ada', '~'));
  expect(text.indexOf('## Launcher')).toBeLessThan(text.indexOf('# Night run'));
  expect(text).toContain('log in ~/x');
  expect(stampOf('# Night run 2026-11-13_210000-1', '')).toBe('2026-11-13_210000-1');
  expect(stampOf('', 'run 2026-11-13_210000\nskipped')).toBe('2026-11-13_210000');
});

test('the summary is committed and pushed to the reports clone, without the home folder', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'night-rep-'));
  const bare = path.join(home, 'reports.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['clone', '-q', bare, path.join(home, 'night-reports')], { stdio: 'ignore' });
  fs.mkdirSync(path.join(home, 'night'));
  fs.writeFileSync(path.join(home, 'night', 'launcher.txt'), 'run 2026-11-13_210000\non the charger (100%)\n');
  fs.writeFileSync(path.join(home, 'night', 'last-summary.md'), `# Night run 2026-11-13_210000-9\n\nlog in ${os.homedir()}/.agent-dispatch\n`);
  const env = { ...process.env, AGENT_DISPATCH_HOME: home };
  const { stdout } = await run(process.execPath, ['night-report.js'], { cwd: ROOT, env });
  expect(stdout).toContain('"pushed":true');
  const latest = execFileSync('git', ['--git-dir', bare, 'show', 'HEAD:latest.md'], { encoding: 'utf8' });
  expect(latest).toContain('on the charger');
  expect(latest).toContain('log in ~/.agent-dispatch');
  expect(latest).not.toContain(os.homedir());
  const files = execFileSync('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' });
  expect(files).toContain('runs/2026-11-13_210000-9.md');
});

test('no reports clone: nothing happens', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'night-rep-'));
  const { stdout } = await run(process.execPath, ['night-report.js'], { cwd: ROOT, env: { ...process.env, AGENT_DISPATCH_HOME: home } });
  expect(stdout).toBe('');
});

test('night.sh does not start while another night run is going', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'night-sh-'));
  fs.mkdirSync(path.join(home, '.agent-dispatch', 'night'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agent-dispatch', 'night', 'running.pid'), String(process.pid));
  const { stdout } = await run('/bin/sh', [path.join(ROOT, 'scripts', 'night.sh'), '--scheduled', '--list'], { env: { ...process.env, HOME: home } });
  expect(stdout).toContain('already going');
  expect(fs.readFileSync(path.join(home, '.agent-dispatch', 'night', 'running.pid'), 'utf8')).toBe(String(process.pid));
});
