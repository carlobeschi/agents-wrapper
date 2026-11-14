#!/usr/bin/env node
// @ts-check
// night-report.js: puts the night queue's summary where the cloud threads can
// read it, so nobody has to copy and paste it in the morning.
//
//   node night-report.js            copy, commit and push (night.js and night.sh call it)
//   node night-report.js --dry-run  write the files, don't commit or push
//
// It does nothing unless ~/.agent-dispatch/night-reports is a git clone of a
// PRIVATE repository (set up once, see docs/nuovo-portatile.md). Never point it
// at agents-wrapper or model-behaviour: those are public.
//
// What it writes in that clone:
//   latest.md              the last summary, with the launcher's note on top
//   runs/<stamp>.md        one file per night run, rewritten during the night
// Every file goes through the publish guard first: the home folder becomes ~,
// and the user name, the laptop's git name and email and the macOS full name
// become [redacted]. Commits use the public identity. A push that fails (no
// network, no login) is retried at the next report; the work is never lost.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { HOME_DIR } = require('./config');
const { guard, PUBLIC_NAME, PUBLIC_EMAIL } = require('./publish');

const NIGHT_DIR = path.join(HOME_DIR, 'night');
const REPORTS = process.env.NIGHT_REPORTS_DIR || path.join(HOME_DIR, 'night-reports');

const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

// The text to publish: the launcher's note (night.sh: battery, keys, why it
// didn't start) and the summary, both redacted.
function buildReport({ summary, launcher }, redact) {
  const parts = [];
  if (launcher.trim()) parts.push('## Launcher', '', '```', launcher.trimEnd(), '```', '');
  parts.push(summary.trim() ? summary.trimEnd() : '_No summary yet._', '');
  return redact(parts.join('\n'));
}

// "# Night run 2026-11-13_210002-1234" -> "2026-11-13_210002-1234"; the
// launcher's own stamp when night.js never started.
function stampOf(summary, launcher) {
  const m = summary.match(/^# Night run (\S+)/m) || launcher.match(/^run (\S+)/m);
  return m ? m[1].replace(/[^\w.-]/g, '_') : 'unknown';
}

function git(args, opts = {}) {
  return spawnSync('git', ['-C', REPORTS, ...args], { encoding: 'utf8', timeout: 120000, ...opts });
}

function main(argv) {
  if (!fs.existsSync(path.join(REPORTS, '.git'))) return { skipped: 'no reports clone' };
  const summary = read(path.join(NIGHT_DIR, 'last-summary.md'));
  const launcher = read(path.join(NIGHT_DIR, 'launcher.txt'));
  // A summary older than the launcher's note belongs to an earlier night.
  const sumT = fs.existsSync(path.join(NIGHT_DIR, 'last-summary.md')) ? fs.statSync(path.join(NIGHT_DIR, 'last-summary.md')).mtimeMs : 0;
  const lauT = fs.existsSync(path.join(NIGHT_DIR, 'launcher.txt')) ? fs.statSync(path.join(NIGHT_DIR, 'launcher.txt')).mtimeMs : 0;
  const fresh = sumT >= lauT ? summary : '';
  const { redact, leaks } = guard();
  const text = buildReport({ summary: fresh, launcher }, redact);
  if (leaks(text).length) throw new Error('night-report: a private term is still in the report, nothing written');

  const stamp = stampOf(fresh, launcher);
  fs.mkdirSync(path.join(REPORTS, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(REPORTS, 'latest.md'), text);
  fs.writeFileSync(path.join(REPORTS, 'runs', `${stamp}.md`), text);
  if (argv.includes('--dry-run')) return { written: stamp };

  git(['pull', '--rebase', '--quiet']);
  git(['add', 'latest.md', 'runs']);
  const id = ['-c', `user.name=${PUBLIC_NAME}`, '-c', `user.email=${PUBLIC_EMAIL}`];
  const c = git([...id, 'commit', '--quiet', '-m', `night ${stamp}`]);
  const nothing = c.status !== 0 && /nothing to commit|nothing added/.test(c.stdout + c.stderr);
  const p = git(['push', '--quiet'], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { stamp, committed: c.status === 0 || nothing, pushed: p.status === 0, error: p.status === 0 ? null : (p.stderr || '').trim().split('\n')[0] };
}

if (require.main === module) {
  try {
    const r = main(process.argv.slice(2));
    if (r.skipped) process.exit(0);
    console.log(`night-report: ${JSON.stringify(r)}`);
  } catch (e) { console.error(e.message); process.exit(1); }
}

module.exports = { buildReport, stampOf, main };
