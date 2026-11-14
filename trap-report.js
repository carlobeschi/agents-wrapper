#!/usr/bin/env node
// @ts-check
// trap-report.js: sends the outcome of the "who wrote the rules?" series
// (scripts/rules-author.sh) to the private reports clone
// (~/.agent-dispatch/night-reports, as night-report.js), so the cloud threads
// can read it in the morning.
//
//   node trap-report.js --log <file> --status <code> --series <folder> [--rules <gemini-rules.json>] [--dry-run]
//
// Writes rules-author/latest.md and rules-author/<stamp>.md: the series summary
// and the rules Gemini wrote if the run finished, otherwise the last 80 lines
// of the log and what has been played so far. Through the publish guard (home
// folder, user name and email redacted), committed with the public identity.
// Does nothing without the private clone.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { HOME_DIR } = require('./config');
const { guard, PUBLIC_NAME, PUBLIC_EMAIL } = require('./publish');

const REPORTS = process.env.NIGHT_REPORTS_DIR || path.join(HOME_DIR, 'night-reports');
const arg = (argv, k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

function build({ log, status, summary, progress, rules, stamp }) {
  const ok = String(status) === '0' && summary.trim();
  const tail = log.split('\n').filter(l => !/^\s*$/.test(l)).slice(-80).join('\n');
  let played = [];
  try { played = JSON.parse(progress || '[]').map(p => p.key); } catch { /* none yet */ }
  return [`# Who wrote the rules? Run ${stamp}: ${ok ? 'finished' : `NOT FINISHED (exit ${status})`}`, '',
    ...(ok ? [summary.trimEnd()] : [`Played so far: ${played.join(', ') || 'none'}`, '', 'Last lines of the log:', '', '```', tail, '```']),
    '', '## The rules Gemini wrote', '', rules.trim() ? ['```json', rules.trim(), '```'].join('\n') : '(not written yet)', ''].join('\n');
}

function main(argv) {
  const logFile = arg(argv, '--log'), series = arg(argv, '--series');
  if (!logFile || !series) throw new Error('usage: node trap-report.js --log <file> --status <code> --series <folder> [--rules <file>]');
  const stamp = path.basename(logFile).replace(/\.log$/, '').replace(/[^\w.-]/g, '_');
  const { redact, leaks } = guard();
  const text = redact(build({ log: read(logFile), status: arg(argv, '--status') ?? '?', summary: read(path.join(series, 'summary.md')),
    progress: read(path.join(series, 'progress.json')), rules: read(arg(argv, '--rules') || ''), stamp }));
  if (leaks(text).length) throw new Error('trap report: a private term is still in the report, nothing written');
  if (!fs.existsSync(path.join(REPORTS, '.git'))) return { skipped: 'no reports clone', text };
  fs.mkdirSync(path.join(REPORTS, 'rules-author'), { recursive: true });
  fs.writeFileSync(path.join(REPORTS, 'rules-author', 'latest.md'), text);
  fs.writeFileSync(path.join(REPORTS, 'rules-author', `${stamp}.md`), text);
  if (argv.includes('--dry-run')) return { written: stamp };
  const git = (a, o = {}) => spawnSync('git', ['-C', REPORTS, ...a], { encoding: 'utf8', timeout: 120000, ...o });
  git(['pull', '--rebase', '--quiet']);
  git(['add', 'rules-author']);
  git(['-c', `user.name=${PUBLIC_NAME}`, '-c', `user.email=${PUBLIC_EMAIL}`, 'commit', '--quiet', '-m', `rules-author ${stamp}`]);
  const p = git(['push', '--quiet'], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { stamp, pushed: p.status === 0 };
}

if (require.main === module) {
  try { const r = main(process.argv.slice(2)); console.log(r.skipped ? `trap report: ${r.skipped} (nothing sent)` : `trap report: ${JSON.stringify(r)}`); }
  catch (e) { console.error(e.message); process.exit(1); }
}
module.exports = { build, main };
