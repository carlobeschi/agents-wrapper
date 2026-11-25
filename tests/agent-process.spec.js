// @ts-check
const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const { watchProcess } = require('../agent-process');

test('watchProcess forwards output and exit status, then clears its timeout', async () => {
  let out = '', err = '';
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("reply"); process.stderr.write("warning"); process.exitCode = 7'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    watchProcess({
      child, timeout: 5000,
      onTimeout: () => reject(new Error('unexpected timeout')),
      onStdout: chunk => { out += chunk; },
      onStderr: chunk => { err += chunk; },
      onError: reject,
      onClose: code => resolve(code),
    });
  });

  expect(out).toBe('reply');
  expect(err).toBe('warning');
  expect(result).toBe(7);
});

test('watchProcess marks and terminates a timed-out process', async () => {
  let timedOut = false;
  const started = Date.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    watchProcess({
      child, timeout: 50,
      onTimeout: () => { timedOut = true; },
      onStdout: () => {},
      onStderr: () => {},
      onError: reject,
      onClose: code => resolve(code),
    });
  });

  expect(timedOut).toBe(true);
  expect(result).toBeNull();
  expect(Date.now() - started).toBeLessThan(2000);
});
