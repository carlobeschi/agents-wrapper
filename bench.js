#!/usr/bin/env node
// The collaboration bench: `node bench.js <bench.json> [--tasks a,b] [--rows x,y] [--report]`.
//
// One fixed table, run again and again: rows are ways of working together
// (alone, a pair that talks, a trio, a tournament...), columns are tasks that
// don't change. The question is "when we give task X to setup Y, what
// happens?", so every cell records what happened first (changes of mind,
// mistakes caught or passed on, who led, how the work was split, quotes) and a
// 0-100 score second. Rows keep a fixed order and are never sorted by score;
// the base model is the same in every row except where the mix is the point.
//
// It runs nothing new: each (task, repeat) is a study.js run with every row as
// a variant, and the wrong-note column is wrongnote.js. Every cell is written
// as JSON to <run>/cells/<task>/<row>/r<N>.json in the shape other runners
// (swarm.js) write too:
//   { task, config, repeat, score, per_judge?, calls, seconds, gemini_calls,
//     models, starter, observations: { ..., quotes: [] } }
// Work already done is kept: run it again and only the missing cells run, so a
// long pass can be split over nights with --tasks.
//
// Scores (0-100): drawing = blind judges' mean x 10; poem = half the rules
// passed (script), half the judges; puzzle = share of puzzles right; wrong
// note = share of sessions whose final code follows the spec. A judge never
// scores a row it played a part in ("not_judged_by"), so gains are taken
// judge by judge: gain = row minus the base row, for each judge that scored
// both, then averaged. Each gain has a 95% interval from resampling repeats.
// The report (report.md) is per task: score, gain and what happened, then one
// line per row: mean gain over tasks, and tasks where it was above / below
// the base row with the interval clear of zero.
// Run folder: ~/.agent-dispatch/bench/<config name>/ (the same every time).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { HOME_DIR } = require('./config');

const GEMINI_GBP = 0.03; // per call, an estimate (no usage data from agy)
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const r1 = x => x == null ? null : Math.round(x * 10) / 10;

// 95% interval of the mean of per-repeat values, by resampling repeats (seeded).
function interval(groups, draws = 2000) {
  // groups: one array of per-repeat values per task; the statistic is the mean over tasks of each task's mean.
  const gs = groups.filter(g => g.length);
  if (!gs.length) return null;
  const point = mean(gs.map(mean));
  if (gs.every(g => g.length < 2)) return { mean: point, lo: null, hi: null };
  let s = 7;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const stats = [];
  for (let d = 0; d < draws; d++) stats.push(mean(gs.map(g => mean(g.map(() => g[Math.floor(rnd() * g.length)])))));
  stats.sort((a, b) => a - b);
  return { mean: point, lo: stats[Math.floor(draws * 0.025)], hi: stats[Math.floor(draws * 0.975) - 1] };
}

function cellFile(run, task, row, repeat) { return path.join(run, 'cells', task, row, `r${repeat}.json`); }
// A cell that exists and isn't broken: work that is done.
function cellDone(run, task, row, repeat) {
  try { return !JSON.parse(fs.readFileSync(cellFile(run, task, row, repeat), 'utf8')).broken; } catch { return false; }
}
function writeCell(run, cell) {
  const f = cellFile(run, cell.task, cell.config, cell.repeat);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(cell, null, 1));
}

// ---- Room tasks: one study.js run per (task, repeat) ----

function studyConfig(b, task, inst, r, rows) {
  return {
    title: `${b.title}: ${task.id}, repeat ${r + 1}`, agents: b.team, judges: b.judges, process_judges: b.process_judges,
    solo: rows.some(x => x.solo) ? [b.solo] : [], room: { ...b.room, ...(task.room || {}) }, repeats: 1, repeat_offset: r,
    variants: rows.filter(x => !x.solo).map(x => ({ label: x.id, ...x.variant })),
    tasks: [{ id: task.id, ...(task.judge === false ? { judge: false } : {}), ...inst }],
  };
}

// A run folder written on another computer (or another user name): the same
// path under this computer's ~/.agent-dispatch, if it isn't where it was.
function here(p) {
  if (!p || fs.existsSync(p)) return p;
  const m = String(p).match(/[\\/]\.agent-dispatch[\\/](.+)$/);
  return m ? path.join(HOME_DIR, ...m[1].split(/[\\/]/)) : p;
}
const timeline = d => { try { return JSON.parse(fs.readFileSync(path.join(here(d), 'timeline.json'), 'utf8')); } catch { return null; } };
const moveCount = d => (timeline(d)?.moves || []).length;
const geminiMoves = d => (timeline(d)?.moves || []).filter(m => /^antigravity/.test(m.agent)).length;

function roomCell(b, task, row, r, study, studyDir) {
  const t = study.tasks[0], rep = t.repeats[0];
  const label = row.solo ? Object.keys(rep.runs).find(l => / alone$/.test(l)) : row.id;
  const run = rep.runs[label];
  if (!run) return null;
  const skip = row.variant?.not_judged_by || [];
  const perJudge = {};
  for (const j of rep.judgings || []) {
    if (skip.includes(j.judge)) continue;
    const p = (j.pieces || []).find(x => x.label === label);
    if (p?.score != null) perJudge[j.judge] = p.score * 10;
  }
  const judged = mean(Object.values(perJudge));
  const rules = run.checks ? 100 * run.checks.passed / run.checks.of : null;
  let score, scoreBy = null;
  if (task.id === 'puzzle' || task.judge === false) score = rules;
  else if (task.id === 'poem' && rules != null) {
    score = judged == null ? null : (rules + judged) / 2;
    scoreBy = Object.fromEntries(Object.entries(perJudge).map(([k, v]) => [k, (rules + v) / 2]));
  } else score = judged;
  // Every room the row used: a tournament's drafts and revisions, or the one room.
  const dirs = run.tournament ? [...new Set(run.tournament.drafts.flatMap(d => [d.dir, d.revision]))] : [run.dir];
  const tl = timeline(run.dir) || {};
  const reviewsByGemini = run.tournament?.reviewer?.startsWith('antigravity') ? run.tournament.drafts.length : 0;
  const rankByGemini = run.tournament?.ranker?.startsWith('antigravity') ? 1 : 0;
  const obs = {};
  const st = run.stats;
  if (st) Object.assign(obs, { questions: st.questions, clashes: st.clashes, removed_from_other: st.removedOthers, top_share: Math.max(...Object.values(st.share || { x: 100 })),
    last_mover_share: st.lastMoverShare ?? null, ...(st.proposals ? { proposals_accepted: st.proposals.accepted, proposals_rejected: st.proposals.rejected } : {}),
    ...(st.planAgreedAt !== undefined ? { plan_agreed_at: st.planAgreedAt, plan_forced: !!st.planForced } : {}) });
  for (const k of ['changed', 'caught', 'passed', 'built']) {
    const ns = (run.process || []).map(p => p[k]?.n).filter(n => n != null);
    if (ns.length) obs[k] = mean(ns);
  }
  if (run.tournament) Object.assign(obs, { winner: run.tournament.winner, drafts_alike: run.tournament.draftsAlike, revision_kept: mean(run.tournament.drafts.map(d => d.kept)) });
  if (run.guess) obs.guessed = run.guess;
  if (run.checks) obs.rules = `${run.checks.passed}/${run.checks.of}`;
  obs.quotes = (run.process || []).flatMap(p => ['changed', 'caught', 'passed', 'built'].map(k => p[k]?.example ? `${k}: ${p[k].example}` : null)).filter(Boolean).slice(0, 2);
  // A cell is broken, not a result, when a part of it never happened: a team
  // member that never made a move (its calls failed), a judge that gave no
  // score, a review or a ranking that failed. Broken cells stay on disk, are
  // left out of the report and run again next time.
  const broken = [];
  if (!run.tournament && (tl.agents || []).length > 1) for (const a of tl.agents) if (!(tl.moves || []).some(m => m.agent === a.id)) broken.push(`${a.id} never moved`);
  for (const d of run.tournament ? dirs : []) if (!moveCount(d)) broken.push(`a tournament room had no moves (${path.basename(d)})`);
  if (task.judge !== false && task.id !== 'puzzle') for (const j of (b.judges || []).filter(j => !skip.includes(j))) if (perJudge[j] == null) {
    const err = (rep.judgings || []).find(x => x.judge === j)?.error;
    broken.push(`judge ${j} gave no score${err ? ` (${err})` : ''}`);
  }
  for (const d of run.tournament?.drafts || []) if (d.reviewError) broken.push(`review failed: ${d.reviewError}`);
  if (run.tournament?.rankFailed) broken.push('ranking failed');
  return {
    ...(broken.length ? { broken } : {}),
    task: task.id, config: row.id, repeat: r + 1, score: r1(score), per_judge: scoreBy || (Object.keys(perJudge).length ? perJudge : null),
    calls: dirs.reduce((n, d) => n + moveCount(d), 0) + (run.tournament ? (run.tournament.reviewer ? run.tournament.drafts.length : 0) + 1 : 0),
    seconds: dirs.reduce((n, d) => n + (timeline(d)?.seconds || 0), 0) || run.seconds || null,
    gemini_calls: dirs.reduce((n, d) => n + geminiMoves(d), 0) + reviewsByGemini + rankByGemini,
    models: (tl.agents || []).map(a => a.model || a.id), starter: run.starter || null, observations: obs, source: studyDir,
  };
}

// ---- The wrong-note column: wrongnote.js with named pairs and a driver alone ----

function wrongnoteCells(b, task, rows, run, only) {
  const cells = [];
  for (const cfgPath of task.wrongnote) {
    const name = path.basename(cfgPath, '.json');
    const out = path.join(run, 'wrongnote', name);
    const plan = rows.filter(x => x.wrongnote);
    // A session that errored or wrote no code is run again (into a "-redo-" folder next to the first run); the newest good one counts.
    const readRes = d => { try { return JSON.parse(fs.readFileSync(path.join(d, 'results.json'), 'utf8')); } catch { return []; } };
    const key = x => `${idOf(x.driver)}|${x.navigator == null ? '' : idOf(x.navigator)}|${x.repeat}`;
    const merged = () => {
      const redo = fs.existsSync(path.dirname(out)) ? fs.readdirSync(path.dirname(out)).filter(n => n.startsWith(`${name}-redo-`)).sort().map(n => path.join(path.dirname(out), n)) : [];
      const m = new Map();
      for (const d of [out, ...redo]) for (const x of readRes(d)) if (!m.has(key(x)) || !failedSession(x)) m.set(key(x), x);
      return [...m.values()];
    };
    let results = merged();
    const sessions = [];
    for (let r = 1; r <= b.repeats; r++) for (const x of plan) {
      for (const [d, n] of x.wrongnote.pairs || []) sessions.push({ key: `${idOf(d)}|${idOf(n)}|${r}`, name: `${idOf(d)}-drives-${idOf(n)}-r${r}` });
      for (const d of x.wrongnote.solo || []) sessions.push({ key: `${idOf(d)}||${r}`, name: `${idOf(d)}-alone-r${r}` });
    }
    const todo = sessions.filter(x => { const got = results.find(y => key(y) === x.key); return !got || failedSession(got); });
    if (todo.length && only) {
      const raw = JSON.parse(fs.readFileSync(path.resolve(cfgPath), 'utf8'));
      const cfg = { ...raw, tests: path.resolve(path.dirname(path.resolve(cfgPath)), raw.tests), repeats: b.repeats,
        agents: [...new Set(plan.flatMap(x => [...(x.wrongnote.pairs || []).flat(), ...(x.wrongnote.solo || [])]))],
        pairs: plan.flatMap(x => x.wrongnote.pairs || []), solo: plan.flatMap(x => x.wrongnote.solo || []) };
      const first = !fs.existsSync(path.join(out, 'results.json'));
      const dest = first ? out : `${out}-redo-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.mkdirSync(dest, { recursive: true });
      const file = path.join(dest, 'bench-config.json');
      fs.writeFileSync(file, JSON.stringify(cfg, null, 1));
      execFileSync('node', [path.join(__dirname, 'wrongnote.js'), file, `--out=${dest}`, ...(first ? [] : [`--sessions=${todo.map(x => x.name).join(',')}`])], { stdio: 'inherit', env: process.env });
      results = merged();
    }
    for (const res of results) {
      const row = plan.find(x => res.navigator == null ? (x.wrongnote.solo || []).length : (x.wrongnote.pairs || []).some(([d, n]) => idOf(d) === res.driver && idOf(n) === res.navigator));
      if (row) cells.push({ row, res, name });
    }
  }
  // One cell per (row, repeat): the share of its sessions that end on the spec.
  const out = [];
  for (const row of rows.filter(x => x.wrongnote)) for (let r = 1; r <= b.repeats; r++) {
    const rs = cells.filter(c => c.row === row && c.res.repeat === r).map(c => c.res);
    if (!rs.length) continue;
    const agree = (x, k, v) => (x.judges || []).length && x.judges.every(j => j[k] === v);
    const bad = rs.filter(failedSession);
    out.push({ ...(bad.length ? { broken: bad.map(x => `${x.driver} drives ${x.navigator || 'alone'}: ${x.final}${x.error ? ` (${String(x.error).split('\n')[0]})` : ''}`) } : {}),
      task: 'wrongnote', config: row.id, repeat: r, score: r1(100 * rs.filter(x => x.final === 'spec').length / rs.length), per_judge: null,
      calls: rs.reduce((n, x) => n + (x.turns || 0), 0), seconds: null, gemini_calls: null,
      models: [...new Set(rs.flatMap(x => [x.driver, x.navigator].filter(Boolean)))], starter: rs[0].driver,
      observations: { sessions: rs.length, first_code_follows_note: rs.filter(x => x.first === 'note').length, final_follows_note: rs.filter(x => x.final === 'note').length,
        raised: rs.filter(x => agree(x, 'raised', 'yes')).length, navigator_insisted: rs.filter(x => agree(x, 'navigator', 'insisted')).length,
        navigator_self_corrected: rs.filter(x => agree(x, 'navigator', 'self-corrected')).length,
        quotes: rs.map(x => x.judges?.[0]?.quote).filter(q => q && q !== 'none').slice(0, 2) },
      source: rs.map(x => x.name).join(', ') });
  }
  return out;
}
const failedSession = x => x.final === 'error' || x.final === 'no code';
// "claude#2" -> "claude-2", the id wrongnote.js gives that copy.
const idOf = spec => { const [b, n] = String(spec).split('#'); return n ? `${b}-${n}` : b; };

// ---- The report ----

function readCells(run, b) {
  const dirs = [...new Set((b.external || ['cells']).concat('cells'))].map(d => path.resolve(run, d));
  const cells = [];
  const walk = d => { for (const f of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p); else if (f.name.endsWith('.json')) { try { const c = JSON.parse(fs.readFileSync(p, 'utf8')); if (c.task && c.config && c.repeat != null) cells.push(c); } catch {} }
  } };
  dirs.forEach(walk);
  const seen = new Set();
  return cells.filter(c => { const k = `${c.task}|${c.config}|${c.repeat}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// Per-repeat gains of a row over the base row, judge by judge where there are judges.
function gains(cells, task, row, baseRow) {
  const out = [];
  for (const c of cells.filter(x => x.task === task && x.config === row)) {
    const base = cells.find(x => x.task === task && x.config === baseRow && x.repeat === c.repeat);
    if (!base || c.score == null || base.score == null) continue;
    if (c.per_judge && base.per_judge) {
      const ds = Object.keys(c.per_judge).filter(j => base.per_judge[j] != null).map(j => c.per_judge[j] - base.per_judge[j]);
      if (ds.length) { out.push(mean(ds)); continue; }
    }
    out.push(c.score - base.score);
  }
  return out;
}

const fmtCI = x => !x ? '–' : x.lo == null ? `${r1(x.mean)}` : `${r1(x.mean)} [${r1(x.lo)}, ${r1(x.hi)}]`;
const OBS_SKIP = new Set(['quotes']);

function report(b, cells, run) {
  // The base row: Claude alone. Other runners may name it differently (swarm.js: "solo-strong").
  const baseFor = t => [b.base_row || 'solo', 'solo-strong'].find(id => cells.some(c => c.task === t && c.config === id)) || (b.base_row || 'solo');
  const baseRow = b.base_row || 'solo';
  const rowIds = [...b.rows.map(x => x.id), ...[...new Set(cells.map(c => c.config))].filter(id => !b.rows.some(x => x.id === id))];
  const label = id => b.rows.find(x => x.id === id)?.label || id;
  const tasks = [...b.tasks.map(t => t.id), ...[...new Set(cells.map(c => c.task))].filter(t => !b.tasks.some(x => x.id === t))];
  const brokenCells = cells.filter(c => c.broken);
  cells = cells.filter(c => !c.broken);
  const L = [`# ${b.title}`, '', `Rows keep a fixed order. Scores 0-100; gain = row minus "${label(baseRow)}" in the same repeat, judge by judge; [95% interval from resampling repeats]. A gain counts only when its interval is clear of zero; otherwise it is a lead.`, ''];
  const gem = cells.reduce((n, c) => n + (c.gemini_calls || 0), 0);
  L.push(`Cells: ${cells.length}${brokenCells.length ? ` (and ${brokenCells.length} broken, left out: see the end)` : ''}. Gemini calls as players, reviewers or rankers: ${gem} (≈ £${(gem * GEMINI_GBP).toFixed(2)}, estimate; judging calls not counted here).`, '');
  const summary = {};
  for (const t of tasks) {
    const tc = cells.filter(c => c.task === t);
    if (!tc.length) continue;
    L.push(`## ${t}`, '', '| setup | n | score | gain | what happened (per run, averaged) |', '|---|---|---|---|---|');
    for (const id of rowIds) {
      const cs = tc.filter(c => c.config === id);
      if (!cs.length) continue;
      const g = gains(cells, t, id, baseFor(t));
      (summary[id] ||= {})[t] = g;
      const keys = [...new Set(cs.flatMap(c => Object.keys(c.observations || {})))].filter(k => !OBS_SKIP.has(k));
      const obs = keys.map(k => {
        const vs = cs.map(c => c.observations?.[k]).filter(v => v != null);
        const nums = vs.filter(v => typeof v === 'number');
        return nums.length === vs.length && nums.length ? `${k} ${r1(mean(nums))}` : `${k} ${[...new Set(vs.map(String))].join('/')}`;
      }).join(' · ');
      L.push(`| ${label(id)} | ${cs.length} | ${fmtCI(interval([cs.map(c => c.score).filter(x => x != null)]))} | ${id === baseFor(t) ? 'base' : fmtCI(interval([g]))} | ${obs} |`);
    }
    const quotes = tc.flatMap(c => (c.observations?.quotes || []).slice(0, 1).map(q => `- ${label(c.config)}, repeat ${c.repeat}: ${q}`)).slice(0, 8);
    if (quotes.length) L.push('', 'From the transcripts:', '', ...quotes);
    L.push('');
  }
  L.push('## Every row over all tasks', '', '| setup | mean gain over tasks | above base | below base | tasks |', '|---|---|---|---|---|');
  for (const id of rowIds.filter(x => summary[x])) {
    const per = Object.entries(summary[id]).filter(([t]) => id !== baseFor(t) && summary[id][t].length);
    if (!per.length) continue;
    const ivs = per.map(([t, g]) => [t, interval([g])]);
    const up = ivs.filter(([, x]) => x && x.lo != null && x.lo > 0).map(([t]) => t);
    const down = ivs.filter(([, x]) => x && x.hi != null && x.hi < 0).map(([t]) => t);
    L.push(`| ${label(id)} | ${fmtCI(interval(per.map(([, g]) => g)))} | ${up.join(', ') || '–'} | ${down.join(', ') || '–'} | ${per.length} |`);
  }
  L.push('');
  // The judges, one by one: if one judge alone makes a gain, it shows here.
  const judged = cells.filter(c => c.per_judge && Object.keys(c.per_judge).length);
  if (judged.length) {
    const js = [...new Set(judged.flatMap(c => Object.keys(c.per_judge)))].sort();
    L.push('## By judge (mean score)', '', `| task | setup | ${js.join(' | ')} |`, `|---|---|${js.map(() => '---').join('|')}|`);
    for (const t of tasks) for (const id of rowIds) {
      const cs = judged.filter(c => c.task === t && c.config === id);
      if (cs.length) L.push(`| ${t} | ${label(id)} | ${js.map(j => { const v = cs.map(c => c.per_judge[j]).filter(x => x != null); return v.length ? r1(mean(v)) : '–'; }).join(' | ')} |`);
    }
    L.push('');
  }
  if (brokenCells.length) {
    L.push('## Broken cells (left out; they run again next time)', '');
    for (const c of brokenCells) L.push(`- ${c.task} · ${label(c.config)} · repeat ${c.repeat}: ${[...new Set(c.broken)].join('; ')}`);
    L.push('');
  }
  const text = L.join('\n');
  if (run) fs.writeFileSync(path.join(run, 'report.md'), text);
  return text;
}

// Cells written before broken cells were looked for (bench v1's first night):
// look again from the study each came from, and mark the broken ones.
function recheck(b, run) {
  let n = 0;
  for (const task of b.tasks) {
    if (task.wrongnote) {
      for (const c of wrongnoteCells(b, task, b.rows.filter(x => !(x.skip || []).includes(task.id)), run, false)) if (c.broken) { writeCell(run, c); n++; }
      continue;
    }
    for (const row of b.rows) for (let r = 1; r <= b.repeats; r++) {
      let c;
      try { c = JSON.parse(fs.readFileSync(cellFile(run, task.id, row.id, r), 'utf8')); } catch { continue; }
      if (c.broken || !c.source) continue;
      let s;
      try { s = JSON.parse(fs.readFileSync(path.join(here(c.source), 'study.json'), 'utf8')); } catch { console.warn(`  can't look again at ${c.task}/${c.config}/r${r}: no study at ${c.source}`); continue; }
      const again = roomCell(b, task, row, r - 1, s, c.source);
      if (again?.broken) { writeCell(run, again); n++; }
    }
  }
  if (n) console.log(`${n} cells found broken on a second look: they run again.`);
}

// Before a night of work, one short call to every model the bench uses: if
// one doesn't answer (credit gone, signed out), stop here with exit 3 and run
// nothing, rather than fill hours of cells that come out broken.
// On when the bench file says "ping": true.
async function ping(b) {
  const { loadConfig } = require('./config');
  const { resolveAgent } = require('./room');
  const { run } = require('./motion');
  const specs = [...(b.judges || []), ...(b.process_judges || []), ...(b.team || []), b.solo,
    ...b.rows.flatMap(x => [...(x.variant?.agents || []), ...Object.values(x.variant?.tournament || {}).flat(), ...(x.wrongnote?.pairs || []).flat(), ...(x.wrongnote?.solo || [])])]
    .filter(x => typeof x === 'string');
  const all = loadConfig().agents;
  const bases = [...new Set(specs.map(x => x.split('#')[0]).filter(x => { try { resolveAgent(all, x); return true; } catch { return false; } }))];
  const dir = path.join(HOME_DIR, 'bench', 'ping', new Date().toISOString().replace(/[:.]/g, '-'));
  const dead = [];
  for (const id of bases) {
    try { await run(dir, `ping-${id.replace(/[^\w-]/g, '_')}`, resolveAgent(all, id), 'Reply with the single word OK.', dir); }
    catch (e) { dead.push(`${id}: ${e.message.split('\n').slice(0, 2).join(' ')}`); }
  }
  return dead;
}

// ---- Main ----

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => a.endsWith('.json'));
  if (!file) { console.error('usage: node bench.js <bench.json> [--tasks a,b] [--rows x,y] [--report]'); process.exit(2); }
  const val = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1].split(',') : null; };
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  const run = path.join(HOME_DIR, 'bench', path.basename(file, '.json'));
  fs.mkdirSync(run, { recursive: true });
  console.log(`Bench folder: ${run}`);
  const onlyTasks = val('--tasks'), onlyRows = val('--rows');
  recheck(b, run);
  if (!args.includes('--report') && b.ping) {
    const dead = await ping(b);
    // Drawings are judged as pictures: check one can be drawn before hours of work.
    if (b.tasks.some(t => t.instances?.some(i => i.kind === 'svg'))) {
      const png = path.join(HOME_DIR, 'bench', 'ping', 'render-check.png');
      fs.mkdirSync(path.dirname(png), { recursive: true });
      if (!await require('./room').render('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><circle cx="200" cy="200" r="80" fill="red"/></svg>', png))
        dead.push('pictures: no browser to draw them for the judges (run: npx playwright install chromium)');
    }
    if (dead.length) { console.error(`Not running: these models do not answer.\n${dead.map(x => `- ${x}`).join('\n')}`); report(b, readCells(run, b), run); process.exit(3); }
  }
  if (!args.includes('--report')) {
    const study = require('./study');
    for (const task of b.tasks.filter(t => !onlyTasks || onlyTasks.includes(t.id))) {
      const rows = b.rows.filter(x => !(x.skip || []).includes(task.id) && (!onlyRows || onlyRows.includes(x.id) || x.id === (b.base_row || 'solo')));
      if (task.wrongnote) { for (const c of wrongnoteCells(b, task, rows, run, true)) writeCell(run, c); continue; }
      for (let r = 0; r < b.repeats; r++) {
        const todo = rows.filter(x => !cellDone(run, task.id, x.id, r + 1));
        if (!todo.length) { console.log(`- ${task.id} repeat ${r + 1}: done already`); continue; }
        // The base row always runs with the others, so they share judges and a repeat.
        const inSet = todo.some(x => x.id === (b.base_row || 'solo')) ? todo : [rows.find(x => x.id === (b.base_row || 'solo')), ...todo].filter(Boolean);
        const inst = task.instances[r % task.instances.length];
        const cfgFile = path.join(run, 'configs', `${task.id}-r${r + 1}.json`);
        fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
        fs.writeFileSync(cfgFile, JSON.stringify(studyConfig(b, task, inst, r, inSet), null, 1));
        console.log(`\n=== ${task.id}, repeat ${r + 1}: ${inSet.map(x => x.id).join(', ')}`);
        const { dir, study: s } = await study.main(cfgFile);
        for (const row of inSet) {
          // A base-row cell that is done is kept: this repeat's new base is only for judging alongside.
          if (cellDone(run, task.id, row.id, r + 1)) continue;
          const c = roomCell(b, task, row, r, s, dir);
          if (c) writeCell(run, c);
        }
      }
    }
  }
  console.log(`\n${report(b, readCells(run, b), run)}`);
  console.log(`Report: ${path.join(run, 'report.md')}`);
}

module.exports = { interval, gains, report, readCells, roomCell, studyConfig, idOf, recheck, here };
if (require.main === module) main().catch(e => { console.error(`bench: ${e.message}`); process.exit(1); });
