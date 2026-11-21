// Visible tests (the agents see this file). Each check runs in its own
// process with a time limit, so a slow or stuck check fails on its own.
// Exit code 1 if any check fails.
const { spawnSync } = require('child_process');
const checks = require('./checks');
const LIMIT_MS = 6000;
const name = process.argv[2];
if (name) {
  Promise.resolve().then(() => checks[name](require('../notes.js')))
    .then(() => process.exit(0), e => { console.error(String(e && e.message || e).split('\n')[0]); process.exit(1); });
} else {
  const failed = [];
  const names = Object.keys(checks);
  for (const k of names) {
    const r = spawnSync(process.execPath, [__filename, k], { timeout: LIMIT_MS, encoding: 'utf8' });
    const ok = r.status === 0;
    if (!ok) failed.push(k);
    console.log(`CHECK ${k} ${ok ? 'pass' : `fail: ${r.error || r.signal ? 'too slow (over 6 s)' : String(r.stderr || '').trim().split('\n').pop()}`}`);
  }
  console.log(`visible tests: ${names.length - failed.length} of ${names.length} pass`);
  process.exit(failed.length ? 1 : 0);
}
