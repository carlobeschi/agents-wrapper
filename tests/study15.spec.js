// @ts-check
// Study 15 phase 0 (Python): puzzles with one answer, calibration measure, team turns,
// all with a fake model. The GPU run itself (phase0_modal.py) is not tested here.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const path = require('path');

test('study 15 core: puzzles, wrong note calibration, team turns (python, fake model)', () => {
  const out = execFileSync('python3', ['-I', path.join(__dirname, '..', 'study15', 'test_core.py')], { encoding: 'utf8', timeout: 120000 });
  expect(out).toContain('ok test_run_all_and_calibration');
});

const fs = require('fs');
const os = require('os');
// study15.sh with a fake modal: the outcome (summary, or the end of the log on a failure) reaches the reports clone, redacted.
for (const ok of [true, false]) test(`study15.sh sends the outcome to the reports clone (${ok ? 'finished' : 'failed'})`, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 's15-'));
  const bare = path.join(home, 'reports.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['clone', '-q', bare, path.join(home, '.agent-dispatch', 'night-reports')], { stdio: 'ignore' });
  fs.mkdirSync(path.join(home, '.study15-venv', 'bin'), { recursive: true });
  const modal = path.join(home, '.study15-venv', 'bin', 'modal');
  fs.writeFileSync(modal, ok
    ? `#!/bin/sh\nd="$HOME/.agent-dispatch/study15/phase0/2026-11-13-180000"; mkdir -p "$d"; printf '# Study 15, phase 0\\n\\nGate: **PASS** in %s\\n' "$HOME" > "$d/summary.md"; echo done\n`
    : `#!/bin/sh\necho "Traceback in $HOME/x"\necho "ValueError: 'aimv2' is already used by a Transformers config"\nexit 1\n`);
  fs.chmodSync(modal, 0o755);
  let status = 0;
  try { execFileSync('sh', [path.join(__dirname, '..', 'scripts', 'study15.sh')], { env: { ...process.env, HOME: home, AGENT_DISPATCH_HOME: path.join(home, '.agent-dispatch'), STUDY15_NO_PULL: '1' }, encoding: 'utf8' }); }
  catch (e) { status = e.status; }
  expect(status).toBe(ok ? 0 : 1);
  const latest = execFileSync('git', ['--git-dir', bare, 'show', 'HEAD:study15/latest.md'], { encoding: 'utf8' });
  expect(latest).toContain(ok ? 'finished' : 'FAILED (exit 1)');
  expect(latest).toContain(ok ? 'Gate: **PASS**' : "'aimv2' is already used");
  expect(latest).not.toContain(home);
});
