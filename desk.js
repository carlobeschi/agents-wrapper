#!/usr/bin/env node
// @ts-check
// The desk: a shared board of tasks that agents borrow, the way the P = NP
// fleet (pequalnp.com/join.txt) hands out proof steps. Nobody assigns work.
// An agent asks for the next free task and gets it on a lease; it renews the
// lease while it works and gives the task back with a reason. A task given
// back as done is judged at once by its check (a test command written by a
// person) or, without one, waits for a person's review. People see the board
// in a browser and add tasks, comments and verdicts (also from Open WebUI,
// examples/desk/openwebui_desk_tool.py).
//
//   node desk.js init <dir> --from <example dir>        copy a round (goal.json, checks/, work/)
//   node desk.js serve <dir> [--port 8790]              run the desk on 127.0.0.1
//   node desk.js report <dir>                           what happened, from events.jsonl
//   node desk.js table <runs dir> <prefix>              one row per run <prefix>-*, means per side
//
// Workers are desk-worker.js. Everything lives in <dir>: desk.json (the
// board), events.jsonl (every step, for the report), work/ (the shared
// output the agents write), checks/ (the judges, out of the agents' reach).

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const die = msg => { console.error(msg); process.exit(1); };
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const now = () => Date.now();
const iso = t => new Date(t).toISOString();

const DEFAULTS = { budget_usd: 20, lease_seconds: 1200, max_lease_seconds: 6 * 3600, max_attempts: 3, check_timeout_seconds: 120 };

// ---------- the board ----------

function load(dir) {
  const goal = readJSON(path.join(dir, 'goal.json'), null);
  if (!goal) die(`No goal.json in ${dir}. Start with: node desk.js init ${dir} --from examples/desk/round1`);
  const saved = readJSON(path.join(dir, 'desk.json'), null);
  if (saved) return saved;
  return {
    goal: goal.goal, settings: { ...DEFAULTS, ...(goal.settings || {}) }, spent_usd: 0, comments: [],
    tasks: (goal.tasks || []).map(t => ({ needs: [], ...t, status: 'open', attempts: 0, holder: null, lease: null, notes: [], by: 'goal' })),
  };
}

function save(dir, board) {
  const f = path.join(dir, 'desk.json');
  fs.writeFileSync(f + '.tmp', JSON.stringify(board, null, 2));
  fs.renameSync(f + '.tmp', f);
}

function log(dir, ev) {
  fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ at: iso(now()), ...ev }) + '\n');
  snapshot(dir, ev);
}

// A git snapshot of work/ at every event, in <dir>/snap.git (outside work/,
// so the agents do not see it): which lines each worker touched, and what
// changed between an acceptance and a break. Made at init when git is there;
// without it the desk runs the same, with no snapshots. Never pushed. With
// several workers at once, a snapshot taken at one worker's event can hold
// another's unfinished edits: attribution is by event, not by keystroke.
function snapshot(dir, ev) {
  const gitDir = path.join(dir, 'snap.git');
  if (!fs.existsSync(gitDir)) return;
  const git = a => execFileSync('git', ['--git-dir', gitDir, '--work-tree', path.join(dir, 'work'), '-c', 'user.name=desk', '-c', 'user.email=desk@localhost', '-c', 'commit.gpgsign=false', ...a], { stdio: 'ignore' });
  const who = ev.worker || ev.by;
  try {
    git(['add', '-A']);
    git(['commit', '-q', '--allow-empty', '--no-verify', '-m', [ev.ev, ev.task, who].filter(Boolean).join(' '), ...(who ? ['--author', `${who} <${who}@desk>`] : [])]);
  } catch { /* a snapshot is a record, never a reason to stop the desk */ }
}

// A lease ends lease_seconds after the last renewal, and never more than
// max_lease_seconds after it was taken.
function expire(dir, board) {
  for (const t of board.tasks) {
    if (t.status !== 'leased' || !t.lease) continue;
    const end = Math.min(t.lease.renewed + board.settings.lease_seconds * 1000, t.lease.taken + board.settings.max_lease_seconds * 1000);
    if (now() > end) {
      log(dir, { ev: 'expired', task: t.id, worker: t.holder });
      t.notes.push({ by: 'desk', at: iso(now()), text: `The lease of ${t.holder} ran out before the task came back.` });
      t.status = 'open'; t.holder = null; t.lease = null;
    }
  }
}

const ready = (board, t) => t.status === 'open' && t.needs.every(id => board.tasks.find(x => x.id === id)?.status === 'done');

function summary(board) {
  return board.tasks.map(t => ({ id: t.id, title: t.title, status: t.status, holder: t.holder, needs: t.needs, attempts: t.attempts, by: t.by }));
}

function specText(dir, t) {
  if (!t.spec) return '';
  const f = path.resolve(dir, t.spec);
  if (!f.startsWith(path.resolve(dir) + path.sep)) return '';
  try { return fs.readFileSync(f, 'utf8'); } catch { return ''; }
}

// The check is a command from goal.json (written by a person, never by the
// agents or by the HTTP side), run in work/. Exit 0 = accepted.
function runCheck(dir, board, t) {
  return new Promise(resolve => {
    const [cmd, ...rest] = t.check;
    execFile(cmd, rest, { cwd: path.join(dir, 'work'), timeout: board.settings.check_timeout_seconds * 1000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, out: (String(stdout) + String(stderr)).trim().slice(-2000) }));
  });
}

// ---------- the HTTP side ----------

function body(req) {
  return new Promise(resolve => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
  });
}

const clip = (s, n) => String(s ?? '').slice(0, n);

function page(board) {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = board.tasks.map(t => `<tr class="${t.status}"><td>${esc(t.id)}</td><td>${esc(t.title)}</td><td>${esc(t.status)}</td><td>${esc(t.holder || '')}</td><td>${esc(t.needs.join(', '))}</td><td>${t.attempts}</td><td>${esc((t.notes.at(-1) || {}).text || '').slice(0, 300)}</td></tr>`).join('');
  const comments = board.comments.slice(-15).reverse().map(c => `<li><b>${esc(c.by)}</b> ${esc(c.text)}</li>`).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5">
<title>Desk</title><style>body{font:15px system-ui;margin:16px;background:#fff;color:#222}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left;vertical-align:top}
.done td:nth-child(3){color:#2a7}.leased td:nth-child(3){color:#d97757}.stuck td:nth-child(3),.review td:nth-child(3){color:#b33}@media(prefers-color-scheme:dark){body{background:#151515;color:#ddd}td,th{border-color:#333}}</style>
<h1>${esc(board.goal)}</h1><p>Spent about $${board.spent_usd.toFixed(2)} of $${board.settings.budget_usd}.</p>
<table><tr><th>Task</th><th>What</th><th>Status</th><th>Held by</th><th>Needs</th><th>Tries</th><th>Last note</th></tr>${rows}</table>
<h2>Comments</h2><ul>${comments || '<li>None yet.</li>'}</ul>`;
}

function serve(dir, port) {
  let board = load(dir);
  save(dir, board);
  const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const byLease = id => board.tasks.find(t => t.lease && t.lease.id === id);

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url || '/', 'http://desk');
    const q = k => u.searchParams.get(k) || '';
    expire(dir, board);
    try {
      if (req.method === 'GET' && u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(page(board)); }
      if (req.method === 'GET' && u.pathname === '/board') {
        return send(res, 200, { goal: board.goal, spent_usd: board.spent_usd, budget_usd: board.settings.budget_usd, tasks: summary(board), comments: board.comments.slice(-20) });
      }
      if (req.method === 'GET' && u.pathname === '/next') {
        const worker = clip(q('worker'), 40) || 'anonymous';
        if (board.spent_usd >= board.settings.budget_usd) return send(res, 200, { status: 'budget' });
        const t = board.tasks.find(x => ready(board, x));
        if (!t) {
          const open = board.tasks.some(x => ['open', 'leased'].includes(x.status));
          return send(res, 200, { status: open ? 'wait' : 'done' });
        }
        t.status = 'leased'; t.holder = worker; t.attempts += 1;
        t.lease = { id: crypto.randomUUID(), taken: now(), renewed: now() };
        log(dir, { ev: 'leased', task: t.id, worker, attempt: t.attempts });
        save(dir, board);
        return send(res, 200, {
          status: 'task', lease: t.lease.id, beat_seconds: Math.max(1, Math.floor(board.settings.lease_seconds / 2)),
          goal: board.goal, task: { id: t.id, title: t.title, detail: t.detail, spec: specText(dir, t), notes: t.notes.slice(-5), has_check: Array.isArray(t.check) },
          board: summary(board), comments: board.comments.slice(-10),
        });
      }
      if (req.method === 'POST' && u.pathname === '/beat') {
        const t = byLease(q('lease'));
        if (!t || t.status !== 'leased') return send(res, 410, { error: 'lease gone' });
        t.lease.renewed = now();
        save(dir, board);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && u.pathname === '/release') {
        const b = await body(req);
        const t = byLease(String(b.lease || ''));
        const cost = Number(b.cost_usd) > 0 ? Number(b.cost_usd) : 0;
        board.spent_usd += cost; // spent even when the work came back too late
        if (!t || t.status !== 'leased') { save(dir, board); return send(res, 410, { error: 'lease gone' }); }
        const worker = t.holder;
        t.lease = null; t.holder = null;
        const note = clip(b.note, 2000);
        if (note) t.notes.push({ by: worker, at: iso(now()), text: note });
        let verdict = 'open';
        if (b.reason === 'submitted' && Array.isArray(t.check)) {
          const r = await runCheck(dir, board, t);
          verdict = r.ok ? 'done' : 'open';
          if (!r.ok) t.notes.push({ by: 'check', at: iso(now()), text: `Rejected by the check:\n${r.out}` });
          log(dir, { ev: r.ok ? 'accepted' : 'rejected', task: t.id, worker, cost_usd: cost });
          // recheck_done: work in one shared folder can break what was already
          // accepted. After each acceptance, rerun the checks of the other done
          // tasks; one that fails now goes back on the board, and it is logged.
          if (r.ok && board.settings.recheck_done) {
            for (const o of board.tasks.filter(x => x !== t && x.status === 'done' && Array.isArray(x.check))) {
              const again = await runCheck(dir, board, o);
              if (again.ok) continue;
              o.status = 'open'; o.attempts = Math.max(0, o.attempts - 1);
              o.notes.push({ by: 'check', at: iso(now()), text: `Was accepted, but fails now (after ${t.id} by ${worker} was accepted):\n${again.out}` });
              log(dir, { ev: 'broken', task: o.id, after: t.id, worker });
            }
          }
        } else if (b.reason === 'submitted') {
          verdict = 'review';
          log(dir, { ev: 'submitted', task: t.id, worker, cost_usd: cost });
        } else {
          log(dir, { ev: 'released', task: t.id, worker, reason: clip(b.reason, 40), cost_usd: cost });
        }
        if (verdict === 'open' && t.attempts >= board.settings.max_attempts) verdict = 'stuck';
        t.status = verdict;
        save(dir, board);
        return send(res, 200, { status: verdict, notes: t.notes.slice(-2) });
      }
      if (req.method === 'POST' && u.pathname === '/tasks') {
        const b = await body(req);
        const title = clip(b.title, 200).trim();
        if (!title) return send(res, 400, { error: 'title needed' });
        const id = `p${board.tasks.filter(t => t.by !== 'goal').length + 1}`;
        // Tasks added over HTTP never carry a check command: they go to review.
        board.tasks.push({ id, title, detail: clip(b.detail, 4000), needs: [], status: 'open', attempts: 0, holder: null, lease: null, notes: [], by: clip(b.by, 60) || 'someone' });
        log(dir, { ev: 'task added', task: id, by: clip(b.by, 60) });
        save(dir, board);
        return send(res, 200, { id });
      }
      if (req.method === 'POST' && u.pathname === '/comment') {
        const b = await body(req);
        const text = clip(b.text, 2000).trim(), by = clip(b.by, 60) || 'someone';
        if (!text) return send(res, 400, { error: 'text needed' });
        const t = b.task ? board.tasks.find(x => x.id === b.task) : null;
        if (b.task && !t) return send(res, 404, { error: 'no such task' });
        if (t) t.notes.push({ by, at: iso(now()), text }); else board.comments.push({ by, at: iso(now()), text });
        log(dir, { ev: 'comment', task: t ? t.id : null, by });
        save(dir, board);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && u.pathname === '/review') {
        const b = await body(req);
        const t = board.tasks.find(x => x.id === b.task);
        if (!t || t.status !== 'review') return send(res, 409, { error: 'that task is not waiting for review' });
        const by = clip(b.by, 60) || 'someone';
        if (b.note) t.notes.push({ by, at: iso(now()), text: clip(b.note, 2000) });
        t.status = b.verdict === 'accept' ? 'done' : (t.attempts >= board.settings.max_attempts ? 'stuck' : 'open');
        log(dir, { ev: b.verdict === 'accept' ? 'accepted' : 'rejected', task: t.id, by, judge: 'person' });
        save(dir, board);
        return send(res, 200, { status: t.status });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) { send(res, 500, { error: String(e && e.message || e) }); }
  });
  server.listen(port, '127.0.0.1', () => console.log(`Desk for "${board.goal}" on http://127.0.0.1:${port}`));
}

// ---------- the report ----------

function report(dir) {
  const evs = fs.existsSync(path.join(dir, 'events.jsonl'))
    ? fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const board = load(dir);
  const n = e => evs.filter(x => x.ev === e).length;
  const times = evs.map(e => Date.parse(e.at));
  const accepted = evs.filter(e => e.ev === 'accepted').map(e => Date.parse(e.at));
  const workers = [...new Set(evs.filter(e => e.ev === 'leased').map(e => e.worker))];
  const per = workers.map(w => `${w}: ${evs.filter(e => e.ev === 'accepted' && e.worker === w).length} accepted of ${evs.filter(e => e.ev === 'leased' && e.worker === w).length} taken`);
  const count = s => board.tasks.filter(t => t.status === s).length;
  // The run's folder and first event, so a pasted report can be matched to
  // the files it came from (24 Nov: a report and a folder turned out to be
  // two different runs).
  const lines = [
    `Run: ${path.resolve(dir)}, first event ${evs.length ? evs[0].at : 'none'}`,
    `Goal: ${board.goal}`,
    `Tasks: ${board.tasks.length} (done ${count('done')}, waiting for review ${count('review')}, stuck ${count('stuck')}, open ${count('open') + count('leased')})`,
    `Leases taken ${n('leased')}, accepted ${n('accepted')}, rejected ${n('rejected')}, given back ${n('released')}, ran out ${n('expired')}`,
    `Accepted work broken later by other work: ${n('broken')} times`,
    `Workers ${workers.length}. ${per.join('; ')}`,
    `Time from first lease to last acceptance: ${times.length && accepted.length ? ((Math.max(...accepted) - Math.min(...times)) / 60000).toFixed(1) + ' min' : 'n/a'}`,
    `Spent about $${board.spent_usd.toFixed(2)}`,
  ];
  // final_check in the settings: one command run on the work as it ends up,
  // whatever the board says (e.g. the whole test suite).
  const fc = board.settings.final_check;
  if (Array.isArray(fc)) {
    let out;
    try { out = execFileSync(fc[0], fc.slice(1), { cwd: path.join(dir, 'work'), encoding: 'utf8', timeout: 300000 }); } catch (e) { out = String(e.stdout || e.message); }
    lines.push(`Final check: ${out.trim().split('\n')[0]}`);
  }
  console.log(lines.join('\n'));
}

// ---------- set-up ----------

function init(dir, from) {
  if (!from || !fs.existsSync(path.join(from, 'goal.json'))) die('Usage: node desk.js init <dir> --from <example dir with goal.json>');
  if (fs.existsSync(path.join(dir, 'desk.json'))) die(`${dir} already has a desk. Use a new folder for a new run.`);
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(from, dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'work'), { recursive: true });
  // "work_files" in goal.json: copies the agents may read (and may change:
  // the checks never use them), e.g. a copy of the tests as a reference.
  const goal = readJSON(path.join(dir, 'goal.json'), {});
  for (const [to, src] of Object.entries(goal.work_files || {})) {
    const a = path.resolve(dir, src), b = path.resolve(dir, 'work', to);
    if (!a.startsWith(path.resolve(dir) + path.sep) || !b.startsWith(path.resolve(dir, 'work') + path.sep)) die(`work_files: ${to} must stay inside the run folder`);
    fs.cpSync(a, b, { recursive: true });
  }
  try {
    execFileSync('git', ['--git-dir', path.join(dir, 'snap.git'), 'init', '-q'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(dir, 'snap.git', 'info', 'exclude'), [...Object.keys(goal.work_files || {}), '.nwave/'].map(x => `/${x}`).join('\n') + '\n');
  } catch { fs.rmSync(path.join(dir, 'snap.git'), { recursive: true, force: true }); }
  console.log(`Ready: ${dir}. Next: node desk.js serve ${dir}`);
}

// ---------- a table over several runs ----------

// One row per run folder <runs>/<prefix>-*, from the same events as the
// report, then the mean time and cost per side (folder names with "solo" or
// not). The README column says whether the agents left a README.md in work/,
// which the plain rounds do not ask for.
function table(runs, prefix) {
  const dirs = fs.readdirSync(runs).filter(d => d.startsWith(prefix + '-') && fs.existsSync(path.join(runs, d, 'desk.json'))).sort();
  if (!dirs.length) die(`No runs named ${prefix}-* in ${runs}`);
  const rows = dirs.map(d => {
    const dir = path.join(runs, d), board = load(dir);
    const evs = fs.existsSync(path.join(dir, 'events.jsonl')) ? fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    const n = e => evs.filter(x => x.ev === e).length;
    const times = evs.map(e => Date.parse(e.at)), acc = evs.filter(e => e.ev === 'accepted').map(e => Date.parse(e.at));
    const min = times.length && acc.length ? (Math.max(...acc) - Math.min(...times)) / 60000 : NaN;
    const fc = board.settings.final_check;
    let final = '';
    if (Array.isArray(fc)) {
      let out;
      try { out = execFileSync(fc[0], fc.slice(1), { cwd: path.join(dir, 'work'), encoding: 'utf8', timeout: 300000 }); } catch (e) { out = String(e.stdout || e.message); }
      const first = out.trim().split('\n')[0];
      const m = first.match(/^(\d+ of \d+)/);
      final = m ? m[1] : first.slice(0, 30);
    }
    return { d, solo: /solo/.test(d), workers: new Set(evs.filter(e => e.ev === 'leased').map(e => e.worker)).size,
      done: `${board.tasks.filter(t => t.status === 'done').length}/${board.tasks.length}`, leased: n('leased'), rejected: n('rejected'),
      broken: n('broken'), expired: n('expired'), min, usd: board.spent_usd, final, readme: fs.existsSync(path.join(dir, 'work', 'README.md')) ? 'yes' : 'no' };
  });
  const head = ['run', 'workers', 'done', 'leases', 'rejected', 'broken', 'ran out', 'minutes', 'cost $', 'final check', 'README'];
  const cells = rows.map(r => [r.d, r.workers, r.done, r.leased, r.rejected, r.broken, r.expired, isNaN(r.min) ? 'n/a' : r.min.toFixed(1), r.usd.toFixed(2), r.final, r.readme].map(String));
  const w = head.map((h, i) => Math.max(h.length, ...cells.map(c => c[i].length)));
  const line = c => c.map((x, i) => x.padEnd(w[i])).join('  ');
  const out = [line(head), ...cells.map(line), ''];
  for (const [label, solo] of [['group', false], ['solo', true]]) {
    const rs = rows.filter(r => r.solo === solo && !isNaN(r.min));
    if (rs.length) out.push(`${label}: ${rs.length} runs, mean ${(rs.reduce((a, r) => a + r.min, 0) / rs.length).toFixed(1)} min (from ${Math.min(...rs.map(r => r.min)).toFixed(1)} to ${Math.max(...rs.map(r => r.min)).toFixed(1)}), mean $${(rs.reduce((a, r) => a + r.usd, 0) / rs.length).toFixed(2)}`);
  }
  console.log(out.join('\n'));
}

const [cmd, dir] = args;
if (cmd === 'init' && dir) init(dir, opt('--from'));
else if (cmd === 'serve' && dir) serve(dir, Number(opt('--port', '8790')));
else if (cmd === 'report' && dir) report(dir);
else if (cmd === 'table' && dir && args[2]) table(dir, args[2]);
else die('Usage: node desk.js init <dir> --from <example> | serve <dir> [--port 8790] | report <dir> | table <runs dir> <prefix>');
