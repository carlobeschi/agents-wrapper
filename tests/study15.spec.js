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
