#!/usr/bin/env node
// study15/report.js: sends the outcome of a study 15 run to the private reports
// clone (~/.agent-dispatch/night-reports, the same one night-report.js uses),
// so the cloud threads can read it without anyone copying logs.
//
//   node study15/report.js --log <file> --status <exit code> [--summary <summary.md>] [--dry-run]
//
// Writes study15/latest.md and study15/<stamp>.md: the summary if the run
// finished, otherwise the last 80 lines of the log. Everything goes through the
// publish guard (home folder, user name and email redacted) and is committed
// with the public identity. Does nothing without the private clone.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { HOME_DIR } = require('../config');
const { guard, PUBLIC_NAME, PUBLIC_EMAIL } = require('../publish');

const REPORTS = process.env.NIGHT_REPORTS_DIR || path.join(HOME_DIR, 'night-reports');
const arg = (argv, k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

function build({ log, status, summary, stamp }) {
  const ok = String(status) === '0' && summary.trim();
  const tail = log.split('\n').filter(l => !/^\s*$/.test(l)).slice(-80).join('\n');
  return [`# Study 15 run ${stamp}: ${ok ? 'finished' : `FAILED (exit ${status})`}`, '',
    ...(ok ? [summary.trimEnd()] : ['Last lines of the log:', '', '```', tail, '```']), ''].join('\n');
}

function main(argv) {
  const logFile = arg(argv, '--log');
  if (!logFile) throw new Error('usage: node study15/report.js --log <file> --status <code> [--summary <file>]');
  const stamp = path.basename(logFile).replace(/\.log$/, '').replace(/[^\w.-]/g, '_');
  const { redact, leaks } = guard();
  const text = redact(build({ log: read(logFile), status: arg(argv, '--status') ?? '?', summary: read(arg(argv, '--summary') || ''), stamp }));
  if (leaks(text).length) throw new Error('study15 report: a private term is still in the report, nothing written');
  if (!fs.existsSync(path.join(REPORTS, '.git'))) return { skipped: 'no reports clone', text };
  fs.mkdirSync(path.join(REPORTS, 'study15'), { recursive: true });
  fs.writeFileSync(path.join(REPORTS, 'study15', 'latest.md'), text);
  fs.writeFileSync(path.join(REPORTS, 'study15', `${stamp}.md`), text);
  if (argv.includes('--dry-run')) return { written: stamp };
  const git = (a, o = {}) => spawnSync('git', ['-C', REPORTS, ...a], { encoding: 'utf8', timeout: 120000, ...o });
  git(['pull', '--rebase', '--quiet']);
  git(['add', 'study15']);
  git(['-c', `user.name=${PUBLIC_NAME}`, '-c', `user.email=${PUBLIC_EMAIL}`, 'commit', '--quiet', '-m', `study15 ${stamp}`]);
  const p = git(['push', '--quiet'], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { stamp, pushed: p.status === 0 };
}

if (require.main === module) {
  try { const r = main(process.argv.slice(2)); console.log(r.skipped ? `study15 report: ${r.skipped} (nothing sent)` : `study15 report: ${JSON.stringify(r)}`); }
  catch (e) { console.error(e.message); process.exit(1); }
}
module.exports = { build, main };
