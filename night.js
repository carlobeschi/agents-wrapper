#!/usr/bin/env node
// The night queue: `node night.js [queue.json] [--stop HH:MM] [--stop-at ISO] [--list] [--no-pull]`.
//
// Runs the studies one after the other while the laptop is left alone, and
// stops in time for the morning (The Motion runs at 08:00). Each job is an
// ordinary command (bench.js, swarm.js, ideate.js, study.js...) run from this
// folder; nothing here changes what a job may do.
//
// - The queue is examples/night/queue.json unless another file is given, so a
//   merged pull request changes what runs next (the night starts with
//   `git pull --ff-only`, skipped with --no-pull).
// - A job that ends with exit 0 is marked done in ~/.agent-dispatch/night/
//   state.json and never runs again. A job that fails or is stopped runs again
//   next night; bench.js, swarm.js and ideate.js (with --out) keep the work
//   already done, so a long job is simply spread over several nights.
// - No job starts less than "min_minutes" before the stop time; a job still
//   running at the stop time is stopped (SIGTERM, then SIGKILL after 30 s).
//   "max_minutes" on a job stops it earlier, so one stuck job can't take the
//   whole night.
// - A job with "needs": ["ollama"] is skipped if Ollama doesn't answer.
// - "enabled": false keeps a job in the list without running it.
// - Claude budget: "claude_budget" on the queue is how many Claude Code calls
//   one night may use (Claude's 5-hour usage limit, not money, is what broke
//   the nights of 12-14 Nov). Then every job declares "claude_calls", its
//   expected Claude calls in one night (0 for jobs that don't use Claude). A job
//   that would go over what is left is skipped and runs next night; a later,
//   smaller job may still start. The night's first Claude job always starts,
//   even if bigger than the budget, so a big job gets a night to itself. The
//   calls are counted for real (config.js noteCall, via NIGHT_CLAUDE_CALLS),
//   so what a job used, not its estimate, comes off the budget.
// - The summary starts with one status line per job: ok, failed or skipped,
//   the reason, and the Claude calls it used.
// - On a Mac, caffeinate keeps the computer from idle sleep while this runs
//   (closing the lid still sends it to sleep).
// Out: ~/.agent-dispatch/night/<stamp>/ with one log per job and summary.md,
// rewritten after every job; ~/.agent-dispatch/night/last-summary.md is a copy.
// - If ~/.agent-dispatch/night-reports is a clone of a private repository,
//   night-report.js pushes the summary there at the start, after every job
//   and at the end, so the cloud threads can read it in the morning.
//
// Queue: { "stop": "07:15", "min_minutes": 20, "claude_budget": 750,
//          "jobs": [ { "name": "bench-v1", "cmd": ["node", "bench.js", "..."], "claude_calls": 150,
//                      "needs": [], "enabled": true, "max_minutes": 90, "note": "..." } ] }
// "~/" at the start of an argument (or after "=") is the home folder.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { HOME_DIR, stamp } = require('./config');

const NIGHT_DIR = path.join(HOME_DIR, 'night');
const STATE = path.join(NIGHT_DIR, 'state.json');

const expandHome = s => String(s).replace(/(^|=)~\//, (_, pre) => pre + os.homedir() + '/');

// The next time it is HH:MM, from `now` (today if still ahead, else tomorrow).
function nextStop(hhmm, now = new Date()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) throw new Error(`stop time "${hhmm}" is not HH:MM`);
  const t = new Date(now);
  t.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t;
}

function loadQueue(file) {
  const q = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(q.jobs)) throw new Error(`${file}: "jobs" must be an array`);
  const names = new Set();
  for (const j of q.jobs) {
    if (typeof j.name !== 'string' || !/^[\w.-]+$/.test(j.name)) throw new Error(`${file}: job name "${j.name}" must be letters, digits, - _ .`);
    if (names.has(j.name)) throw new Error(`${file}: job "${j.name}" appears twice`);
    names.add(j.name);
    if (!Array.isArray(j.cmd) || !j.cmd.length || j.cmd.some(a => typeof a !== 'string')) throw new Error(`${file}: job "${j.name}" needs "cmd" as a list of strings`);
    if (q.claude_budget != null && !(Number.isInteger(j.claude_calls) && j.claude_calls >= 0)) throw new Error(`${file}: job "${j.name}" needs "claude_calls" (its expected Claude calls in one night, 0 if none), because the queue has a "claude_budget"`);
  }
  if (q.claude_budget != null && !(Number.isInteger(q.claude_budget) && q.claude_budget >= 0)) throw new Error(`${file}: "claude_budget" must be a whole number of calls`);
  return q;
}

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { done: {} }; } };
const writeState = s => fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n');

function ollamaUp(timeoutMs = 5000) {
  return new Promise(resolve => {
    const req = http.get('http://127.0.0.1:11434/api/tags', res => { res.resume(); resolve(res.statusCode === 200); });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

const fmtTime = d => d.toTimeString().slice(0, 5);
const fmtDur = ms => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
// Calls a job reported as failed ("  ✗ ...") or done ("  ✓ ...") in this
// night's part of its log. Many failures with exit 0 (an agent out of usage,
// say) means the job's numbers are not to be trusted.
function failedCalls(file) {
  let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch {}
  const starts = [...text.matchAll(/^---- .*\n\$ /gm)];
  if (starts.length) text = text.slice(starts[starts.length - 1].index);
  const failed = (text.match(/^\s*✗ /gm) || []).length, ok = (text.match(/^\s*✓ /gm) || []).length;
  return { failed, ok, suspect: failed >= 5 && failed >= 0.2 * (failed + ok) };
}
// Claude calls a job made, one line each in its calls file.
const countCalls = file => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
// Did Claude (or another agent) say it was out of usage in this night's part of the log?
function hitLimit(file) {
  let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch {}
  const starts = [...text.matchAll(/^---- .*\n\$ /gm)];
  if (starts.length) text = text.slice(starts[starts.length - 1].index);
  return /hit your [\w -]*limit|usage limit|out of usage/i.test(text);
}

// Can a job with this estimate start, with `used` of `budget` calls gone?
function fitsBudget(budget, used, est) {
  if (budget == null || !est) return true;
  if (used === 0) return true; // the night's first Claude job, however big
  return used + est <= budget;
}

// One line per job for the morning: ok / failed / skipped, the reason, Claude calls.
function statusLine(r) {
  const kind = r.result === 'ok' ? 'ok'
    : /^(done before|off|not started|skipped)/.test(r.result || '') ? 'skipped' : 'failed';
  const why = kind === 'ok' ? '' : r.why || r.result || '';
  const bits = [`**${r.name}**: ${kind}${why ? `, ${why}` : ''}`];
  if (r.ms != null) bits.push(fmtDur(r.ms));
  if (r.calls != null) bits.push(`Claude ${r.calls} call${r.calls === 1 ? '' : 's'}${r.est != null ? ` (expected ${r.est})` : ''}`);
  else if (kind === 'skipped' && r.est) bits.push(`expects ${r.est} Claude calls`);
  if (r.limit) bits.push('the log says an agent hit its usage limit');
  return `- ${bits.join(' · ')}`;
}

const tail = (file, n = 15) => { try { return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n).join('\n'); } catch { return ''; } };

// The job running now, stopped too if this script is stopped (Ctrl-C).
let current = null;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { if (current) current('SIGTERM'); process.exit(130); });
}

// Runs one job, its output to `log`, until it ends or `stopAt`.
function runJob(job, log, stopAt, cwd, env = process.env) {
  return new Promise(resolve => {
    const out = fs.openSync(log, 'a');
    fs.writeSync(out, `---- ${new Date().toString()}\n$ ${job.cmd.join(' ')}\n`);
    const [bin, ...args] = job.cmd.map(expandHome);
    const child = spawn(bin === 'node' ? process.execPath : bin, args, { cwd, env, stdio: ['ignore', out, out], detached: true });
    let stopped = false, killTimer = null;
    const kill = sig => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };
    current = kill;
    const stopTimer = setTimeout(() => {
      stopped = true;
      fs.writeSync(out, `\n---- time is up, stopping\n`);
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 30000);
    }, Math.max(0, stopAt - Date.now()));
    const end = (code, err) => {
      clearTimeout(stopTimer); clearTimeout(killTimer); current = null;
      if (err) fs.writeSync(out, `\n---- could not start: ${err.message}\n`);
      fs.closeSync(out);
      resolve({ code, stopped, error: err ? err.message : null });
    };
    child.on('error', err => end(null, err));
    child.on('exit', code => end(code, null));
  });
}

function writeSummary(dir, info, rows) {
  const lines = [
    `# Night run ${info.stamp}`,
    '',
    `Started ${info.start.toString()} · stop time ${info.stopAt.toString()} · queue ${info.queue}`,
    info.pull ? `git pull: ${info.pull}` : '',
    '',
    '## Status',
    '',
    info.budget != null ? `Claude calls tonight: ${info.used} of a budget of ${info.budget}.` : `Claude calls tonight: ${info.used} (no budget set).`,
    '',
    ...rows.map(statusLine),
    '',
    '| Job | Result | Time | Claude calls | Note |',
    '|---|---|---|---|---|',
    ...rows.map(r => `| ${r.name} | ${r.result} | ${r.ms != null ? fmtDur(r.ms) : ''} | ${r.calls ?? ''} | ${r.note || ''} |`),
    '',
  ];
  for (const r of rows.filter(r => r.log)) {
    lines.push(`## ${r.name}: last lines`, '', '```', tail(r.log), '```', '');
  }
  const text = lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'summary.md'), text);
  fs.writeFileSync(path.join(NIGHT_DIR, 'last-summary.md'), text);
}

// Pushes the summary to the private reports clone, if there is one. Never stops the night.
function report() {
  if (!fs.existsSync(path.join(process.env.NIGHT_REPORTS_DIR || path.join(HOME_DIR, 'night-reports'), '.git'))) return;
  const r = spawnSync(process.execPath, [path.join(__dirname, 'night-report.js')], { encoding: 'utf8', timeout: 180000 });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (out) console.log(out);
}

async function main(argv) {
  const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const file = path.resolve(argv.find(a => a.endsWith('.json')) || path.join(__dirname, 'examples', 'night', 'queue.json'));
  const cwd = __dirname;
  fs.mkdirSync(NIGHT_DIR, { recursive: true });

  let pull = null;
  if (!argv.includes('--no-pull') && !argv.includes('--list')) {
    const r = spawnSync('git', ['pull', '--ff-only', '--quiet'], { cwd, encoding: 'utf8' });
    pull = r.status === 0 ? 'ok' : `failed, running the code as it is (${(r.stderr || r.error?.message || '').trim().split('\n')[0]})`;
  }

  const q = loadQueue(file);
  const state = readState();
  const start = new Date();
  const stopAt = opt('--stop-at') ? new Date(opt('--stop-at')) : nextStop(opt('--stop') || q.stop || '07:15', start);
  if (isNaN(stopAt)) throw new Error('--stop-at is not a date');
  const minMs = (q.min_minutes ?? 20) * 60000;

  if (argv.includes('--list')) {
    for (const j of q.jobs) {
      const s = state.done[j.name] ? `done ${state.done[j.name]}` : j.enabled === false ? 'off' : 'to run';
      const c = j.claude_calls != null ? `Claude ~${j.claude_calls}` : '';
      console.log(`${j.name.padEnd(16)} ${s.padEnd(22)} ${c.padEnd(12)} ${j.note || ''}`);
    }
    console.log(`stop time ${stopAt.toString()}${q.claude_budget != null ? ` · Claude budget ${q.claude_budget} calls a night` : ''}`);
    return;
  }

  if (process.platform === 'darwin') {
    try { spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {}
  }

  const st = stamp();
  const dir = path.join(NIGHT_DIR, st);
  fs.mkdirSync(dir, { recursive: true });
  const info = { stamp: st, start, stopAt, queue: path.relative(cwd, file) || file, pull, budget: q.claude_budget ?? null, used: 0 };
  const rows = [];
  console.log(`night run ${st}: until ${stopAt.toString()}, log in ${dir}`);
  writeSummary(dir, info, rows);
  report();

  for (const [k, job] of q.jobs.entries()) {
    const row = { name: job.name, note: job.note || '', est: job.claude_calls ?? null };
    rows.push(row);
    if (state.done[job.name]) { row.result = 'done before'; row.why = `finished ${state.done[job.name]}`; row.note = row.why; row.est = null; writeSummary(dir, info, rows); continue; }
    if (job.enabled === false) { row.result = 'off'; row.why = 'off in the queue'; row.est = null; writeSummary(dir, info, rows); continue; }
    if (stopAt - Date.now() < minMs) { row.result = 'not started'; row.why = row.note = 'too close to the stop time, next night'; writeSummary(dir, info, rows); continue; }
    if (!fitsBudget(info.budget, info.used, job.claude_calls)) {
      row.result = 'skipped'; row.why = row.note = `over the Claude budget (expects ${job.claude_calls} calls, ${Math.max(0, info.budget - info.used)} of ${info.budget} left), next night`;
      console.log(`${fmtTime(new Date())} ${job.name}: skipped, ${row.why}`);
      writeSummary(dir, info, rows); continue;
    }
    if ((job.needs || []).includes('ollama') && !(await ollamaUp())) { row.result = 'skipped'; row.why = row.note = 'Ollama does not answer: open the Ollama app'; writeSummary(dir, info, rows); continue; }

    row.log = path.join(dir, `${String(k + 1).padStart(2, '0')}-${job.name}.log`);
    console.log(`${fmtTime(new Date())} ${job.name}: started`);
    const t0 = Date.now();
    const jobStop = job.max_minutes ? new Date(Math.min(stopAt, t0 + job.max_minutes * 60000)) : stopAt;
    const callsFile = row.log.replace(/\.log$/, '.claude-calls');
    const res = await runJob(job, row.log, jobStop, cwd, { ...process.env, NIGHT_CLAUDE_CALLS: callsFile });
    row.ms = Date.now() - t0;
    row.calls = countCalls(callsFile);
    info.used += row.calls;
    row.limit = hitLimit(row.log);
    if (res.error) { row.result = 'could not start'; row.note = res.error; row.why = `could not start: ${res.error}`; }
    else if (res.stopped) { row.result = 'stopped'; row.note = jobStop < stopAt ? `over its ${job.max_minutes} min; runs again next night` : 'stop time reached; it carries on next night'; row.why = `stopped, ${row.note}`; }
    else if (res.code === 0 && failedCalls(row.log).suspect) { const f = failedCalls(row.log); row.result = `suspect (${f.failed} failed calls of ${f.failed + f.ok})`; row.note = 'exit 0, but many calls failed: not marked done, runs again next night; see the log'; row.why = `exit 0 but ${f.failed} of ${f.failed + f.ok} calls failed, runs again next night`; }
    else if (res.code === 0) { row.result = 'ok'; state.done[job.name] = new Date().toISOString().slice(0, 16).replace('T', ' '); writeState(state); }
    else { row.result = `failed (exit ${res.code})`; row.note = 'runs again next night; see the log'; row.why = `exit ${res.code}, runs again next night`; }
    console.log(`${fmtTime(new Date())} ${job.name}: ${row.result}`);
    writeSummary(dir, info, rows);
    report();
  }
  writeSummary(dir, info, rows);
  report();
  console.log(`summary: ${path.join(dir, 'summary.md')}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { nextStop, loadQueue, expandHome, failedCalls, fitsBudget, statusLine, hitLimit };
