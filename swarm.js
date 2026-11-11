#!/usr/bin/env node
// Swarm study (study 10): `node swarm.js <swarm.json> [--tasks map,nest] [--arms a,b] [--force]`.
//
// Many small agents that coordinate like ants and bees, through marks left in
// a shared environment, with no chat and no one in charge, set against one
// strong agent alone, the small model alone, the best of many isolated copies
// and a boss with workers. Every arm gets the same total number of calls.
//
// Two tasks, both scored by this script (no judges):
//  - map: colour a map of N regions with 4 colours so that no two touching
//    regions share one. The map is built around a hidden solution, so it can
//    always be solved. Score = 100 x (1 - conflicts left / conflicts at start).
//  - nest: choose a new home among N sites. A site's quality is a formula of
//    four numbers, and only an agent that inspects a site sees them. Score =
//    100 x (chosen - worst) / (best - worst); 0 if nothing is chosen.
// Swarm agents see only their own area (map) or the sites they inspected
// (nest), plus marks: area marks (strength + a few words) or a dance board.
// Marks fade every round unless renewed. "swarm-no-marks" hides them (the
// control: is it the mechanism or the numbers?); "swarm-imitation-only" (nest)
// lets only 2 scouts inspect, the rest can only follow dances.
//
// Config:
// { "run": "bench-v1", "small": ["local:qwen3:8b", "local:gemma3:12b"], "strong": "claude",
//   "budget": 60, "swarm": 12, "repeats": 4, "seed": 10, "scale": [4, 24],
//   "map": { "regions": 60, "area": 5 }, "nest": { "sites": 30, "inspect": 2 }, "symmetry": false }
// "symmetry": true adds three arms in which every agent starts in the same
// place (same map area; no site seen yet), so the app breaks no symmetry:
// swarm-marks-same, swarm-no-marks-same and swarm-marks-same-knockout (one
// agent is removed halfway, to see whether the split holds: "rigidity").
// Their cells report areas_by_agent, specialisation_by_agent (1 - normalised
// entropy of the areas each agent worked in), spread_by_round and, with a
// knockout, spread before and after it. Read them run by run: a split that
// goes a different way each run averages out to nothing.
// One small model family per repeat (repeat 1 the first, repeat 2 the second,
// ...), so a 16 GB laptop holds one local model at a time and every family
// plays every arm. The map and sites are the same for every arm of a repeat.
// Agents only write text, which this script parses: no tools, no files.
//
// Every cell goes to ~/.agent-dispatch/bench/<run>/cells/<task>/<arm>/r<N>.json
// in bench.js's shape: { task, config, repeat, score, calls, seconds,
// tokens_est, cost_gbp, models, starter, observations: { ..., quotes } }.
// Cells already there are kept (--force runs them again). Each run's prompts,
// replies and history are in ~/.agent-dispatch/bench/<run>/swarm/.

const fs = require('fs');
const path = require('path');
const { HOME_DIR, loadConfig } = require('./config');
const { resolveAgent } = require('./room');
const { run } = require('./motion');

const COLOURS = ['red', 'green', 'blue', 'yellow'];
const USD_GBP = 0.79;
const PARALLEL = () => Math.max(1, Number(process.env.SWARM_PARALLEL) || 4);

function rng(seed) { let s = (Math.abs(Math.floor(seed)) % 2147483646) + 1; return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }
function shuffle(xs, r) { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const r1 = x => x == null ? null : Math.round(x * 10) / 10;
const clip = (s, n) => { const w = String(s).replace(/["\n]/g, ' ').match(/\S+/g) || []; return w.slice(0, n).join(' '); };

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ---- The map ----

function makeMap(seed, n = 60, area = 5) {
  const r = rng(seed);
  const pts = Array.from({ length: n }, () => ({ x: r(), y: r() }));
  const hidden = pts.map(() => Math.floor(r() * 4));
  const keys = new Set();
  for (let i = 0; i < n; i++) {
    const near = pts.map((p, j) => ({ j, d: (p.x - pts[i].x) ** 2 + (p.y - pts[i].y) ** 2 }))
      .filter(o => o.j !== i && hidden[o.j] !== hidden[i]).sort((a, b) => a.d - b.d).slice(0, 3);
    for (const { j } of near) keys.add(i < j ? `${i}-${j}` : `${j}-${i}`);
  }
  const edges = [...keys].map(k => k.split('-').map(Number));
  const adj = pts.map(() => []);
  for (const [a, b] of edges) { adj[a].push(b); adj[b].push(a); }
  // Areas: horizontal bands of 4 areas each, so an area is a patch of the map.
  const perBand = 4, band = area * perBand;
  const byY = pts.map((p, i) => i).sort((a, b) => pts[a].y - pts[b].y);
  const areas = [];
  for (let s = 0; s < n; s += band) {
    const row = byY.slice(s, s + band).sort((a, b) => pts[a].x - pts[b].x);
    for (let k = 0; k < row.length; k += area) areas.push(row.slice(k, k + area));
  }
  const areaOf = new Array(n);
  areas.forEach((ns, z) => ns.forEach(i => { areaOf[i] = z; }));
  const areaAdj = areas.map(() => new Set());
  for (const [a, b] of edges) if (areaOf[a] !== areaOf[b]) { areaAdj[areaOf[a]].add(areaOf[b]); areaAdj[areaOf[b]].add(areaOf[a]); }
  let start = pts.map(() => Math.floor(r() * 4));
  const m = { n, edges, adj, areas, areaOf, areaAdj: areaAdj.map(s => [...s].sort((a, b) => a - b)), hidden };
  if (conflicts(m, start) === 0) start = start.map((c, i) => i === 0 ? hidden[adj[0][0]] : c); // never start solved
  m.start = start;
  return m;
}
const conflicts = (m, col) => m.edges.filter(([a, b]) => col[a] === col[b]).length;
const areaConflicts = (m, col, z) => m.edges.filter(([a, b]) => col[a] === col[b] && (m.areaOf[a] === z || m.areaOf[b] === z)).length;
const mapScore = (m, col) => Math.max(0, 100 * (1 - conflicts(m, col) / Math.max(1, conflicts(m, m.start))));
const regionLine = (m, col, i) => `region ${i + 1} (${COLOURS[col[i]]}): touches ${m.adj[i].map(j => `${j + 1} (${COLOURS[col[j]]})${col[j] === col[i] ? ' CONFLICT' : ''}`).join(', ')}`;
const MAP_RULES = m => `A map has ${m.n} regions. Each region has one of 4 colours: red, green, blue, yellow. Two regions that touch must not have the same colour: that is a conflict. The goal is a map with no conflicts.`;

function parseMap(text) {
  const out = { set: [], mark: null, go: null, report: '', orders: [], done: false };
  for (const l of String(text).split('\n')) {
    let m;
    if ((m = l.match(/^\W*SET\s+(?:region\s+)?(\d+)\s+(?:to\s+)?(red|green|blue|yellow)\b/i))) out.set.push({ i: Number(m[1]) - 1, c: COLOURS.indexOf(m[2].toLowerCase()) });
    else if ((m = l.match(/^\W*MARK\s+(?:area\s+)?(\d+)\s+([123])\b\s*(.*)$/i))) out.mark ??= { z: Number(m[1]) - 1, s: Number(m[2]), text: clip(m[3], 8) };
    else if ((m = l.match(/^\W*GO\s+(?:to\s+)?(?:area\s+)?(\d+)/i))) out.go ??= Number(m[1]) - 1;
    else if ((m = l.match(/^\W*REPORT\s*:?\s*(.*)$/i))) out.report = clip(m[1], 12);
    else if ((m = l.match(/^\W*W(\d+)\s*:?\s+(?:area\s+)?(\d+)\s*:?\s*(.*)$/i))) out.orders.push({ w: Number(m[1]) - 1, z: Number(m[2]) - 1, text: clip(m[3], 12) });
    else if (/^\W*DONE\b/i.test(l)) out.done = true;
  }
  return out;
}

// ---- The nest ----

function makeNest(seed, n = 30) {
  const r = rng(seed * 7 + 3);
  const d = () => 1 + Math.floor(r() * 10);
  let sites;
  for (;;) {
    sites = Array.from({ length: n }, () => { const s = { size: d(), dryness: d(), height: d(), distance: d() }; s.q = s.size + 2 * s.dryness + s.height - s.distance; return s; });
    const qs = sites.map(s => s.q).sort((a, b) => b - a);
    if (qs[0] > qs[1]) break; // one best site
  }
  const qs = sites.map(s => s.q);
  return { n, sites, best: Math.max(...qs), worst: Math.min(...qs), bestSite: qs.indexOf(Math.max(...qs)) };
}
const nestScore = (nest, i) => i == null || !nest.sites[i] ? 0 : 100 * (nest.sites[i].q - nest.worst) / Math.max(1, nest.best - nest.worst);
const siteLine = (nest, i) => { const s = nest.sites[i]; return `site ${i + 1}: size ${s.size}, dryness ${s.dryness}, height ${s.height}, distance ${s.distance}`; };
const NEST_RULES = nest => `A colony must choose one new home among ${nest.n} sites (numbered 1 to ${nest.n}). A site's quality = size + 2 x dryness + height - distance. Higher is better. Only an agent that inspects a site sees its four numbers.`;

function parseNest(text) {
  const out = { inspect: null, dance: null, vote: null, final: null, report: null, orders: [], decide: null };
  for (const l of String(text).split('\n')) {
    let m;
    if ((m = l.match(/^\W*INSPECT\s+(?:site\s+)?(\d+)/i))) out.inspect ??= Number(m[1]) - 1;
    else if ((m = l.match(/^\W*DANCE\s+(?:site\s+)?(\d+)\s+(-?\d+)/i))) out.dance ??= { i: Number(m[1]) - 1, q: Number(m[2]) };
    else if ((m = l.match(/^\W*VOTE\s+(?:site\s+)?(\d+)/i))) out.vote ??= Number(m[1]) - 1;
    else if ((m = l.match(/^\W*FINAL\s+(?:site\s+)?(\d+)/i))) out.final ??= Number(m[1]) - 1;
    else if ((m = l.match(/^\W*DECIDE\s+(?:site\s+)?(\d+)/i))) out.decide ??= Number(m[1]) - 1;
    else if ((m = l.match(/^\W*REPORT\s*:?\s*(?:score\s*)?(-?\d+)\s*(.*)$/i))) out.report ??= { q: Number(m[1]), text: clip(m[2], 12) };
    else if ((m = l.match(/^\W*W(\d+)\s*:?\s+(?:INSPECT\s+)?(?:site\s+)?(\d+)/i))) out.orders.push({ w: Number(m[1]) - 1, i: Number(m[2]) - 1 });
  }
  return out;
}

// ---- One call, counted ----

// Agents run in an empty folder, away from the run folder (which holds the
// hidden solution and the other agents' replies).
function caller(dir, stats) {
  const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  return async (agent, file, prompt) => {
    stats.calls++;
    try {
      const text = await run(dir, file, agent, prompt, cwd);
      stats.tokens += Math.round((prompt.length + text.length) / 4);
      return text;
    } catch (e) {
      stats.failures++;
      stats.tokens += Math.round(prompt.length / 4);
      console.warn(`  ✗ ${file}: ${String(e.message).split('\n')[0]}`);
      return '';
    }
  };
}

// ---- Map arms ----

async function mapSolo(m, agent, budget, call, tag = 'solo') {
  const col = [...m.start];
  let used = 0;
  for (; used < budget; used++) {
    if (conflicts(m, col) === 0) break;
    const prompt = [MAP_RULES(m), '', `You work alone. Each move you may change up to 2 regions. Move ${used + 1} of at most ${budget}. Conflicts now: ${conflicts(m, col)}.`, '',
      ...m.adj.map((_, i) => regionLine(m, col, i)), '',
      'Reply with these lines only:', 'SET <region> <colour>   (1 or 2 lines)', 'DONE   (instead, if you think the map has no conflicts)'].join('\n');
    const p = parseMap(await call(agent, `${tag}-${String(used + 1).padStart(2, '0')}`, prompt));
    for (const s of p.set.slice(0, 2)) if (col[s.i] != null && s.c >= 0) col[s.i] = s.c;
    if (p.done && !p.set.length) { used++; break; }
  }
  return { col, moves: used };
}

// Specialisation of one agent: 1 - normalised entropy of the areas it worked
// in (1 = always the same area, 0 = spread evenly over all areas).
function specialisation(visits, n) {
  if (!visits.length || n < 2) return null;
  const c = {}; for (const v of visits) c[v] = (c[v] || 0) + 1;
  const h = Object.values(c).reduce((a, x) => { const p = x / visits.length; return a - p * Math.log(p); }, 0);
  return r1(100 * (1 - h / Math.log(Math.min(n, visits.length) || 2))) / 100;
}
const hub = m => m.areaAdj.reduce((best, a, z) => a.length > m.areaAdj[best].length ? z : best, 0);

// What the symmetry-breaking variant reports, per run (never only averaged):
// where each agent worked, how specialised each one is, and how spread out
// the swarm is round by round (before and after a knockout).
function symmetry(obs, agents, visits, spread, n, koAt) {
  obs.areas_by_agent = Object.fromEntries(agents.map((a, k) => [a.id, visits[k].map(v => v + 1)]));
  obs.specialisation_by_agent = Object.fromEntries(agents.map((a, k) => [a.id, specialisation(visits[k], n)]));
  const sp = Object.values(obs.specialisation_by_agent).filter(x => x != null);
  obs.mean_specialisation = sp.length ? r1(100 * sp.reduce((a, b) => a + b, 0) / sp.length) / 100 : null;
  obs.spread_by_round = spread;
  if (koAt != null) {
    const avg = xs => xs.length ? r1(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
    obs.spread_before_knockout = avg(spread.slice(0, koAt));
    obs.spread_after_knockout = avg(spread.slice(koAt));
  }
}

async function mapSwarm(m, agents, rounds, marksOn, call, r, obs, opts = {}) {
  const col = [...m.start];
  const setBy = new Array(m.n).fill(null);
  const zones = m.areas.length;
  const marks = m.areas.map(() => []); // { s, text, by }
  // start "same": everyone begins in one area (the most connected), so any
  // division of the map has to come from the agents, not from the app.
  const where = agents.map((a, k) => opts.start === 'same' ? hub(m) : k % zones);
  const active = agents.map(() => true);
  const visits = agents.map(() => []);
  const spread = [];
  const koAt = opts.knockout && rounds >= 2 ? Math.floor(rounds / 2) : null;
  const madeBy = new Map(); // edge key -> created by a move
  let starter = null, solvedAt = null;
  Object.assign(obs, { marks_left: 0, marks_followed: 0, converged_agents: 0, converged_at_tick: null, reuse: 0, conflicts_undone: 0, overwrites_of_others: 0, out_of_area: 0 });
  const quotes = [];
  const markLine = z => marks[z].length ? marks[z].map(x => `${x.s.toFixed(1)} "${x.text}"`).join('; ') : 'no marks';
  for (let t = 0; t < rounds; t++) {
    if (t === koAt) { active[0] = false; obs.knockout = { round: t + 1, agent: agents[0].id }; }
    agents.forEach((a, k) => { if (active[k]) visits[k].push(where[k]); });
    spread.push(new Set(where.filter((_, k) => active[k])).size);
    const prompts = agents.map((a, k) => {
      const z = where[k];
      return [MAP_RULES(m), '',
        `You are one of ${agents.length} agents working on this map at the same time. Nobody is in charge and there is no chat. You only see the area you are in.${marksOn ? ' Agents leave marks on areas for each other: a mark has a strength (it fades every round unless renewed) and a few words.' : ''}`, '',
        `Round ${t + 1} of ${rounds}. You are in area ${z + 1}. Conflicts touching your area: ${areaConflicts(m, col, z)}.`,
        'Regions in your area:', ...m.areas[z].map(i => regionLine(m, col, i)), '',
        marksOn ? `Marks on your area: ${markLine(z)}` : null,
        `Areas next to yours: ${m.areaAdj[z].map(y => marksOn ? `${y + 1} (${markLine(y)})` : `${y + 1}`).join(', ') || 'none'}`, '',
        'Reply with these lines only:',
        'SET <region> <colour>   (0 to 2 lines, regions in your area only)',
        marksOn ? 'MARK <area> <1-3> <up to 8 words>   (0 or 1 line: your area or one next to it)' : null,
        'GO <area>   (where you will be next round: your area or one next to it)'].filter(x => x != null).join('\n');
    });
    const replies = await pool(agents, PARALLEL(), (a, k) => active[k] ? call(a, `t${t + 1}-${a.id}`, prompts[k]) : '');
    const order = shuffle(agents.map((_, k) => k), r).filter(k => active[k]);
    if (t === 0) starter = agents[order[0]].id;
    for (const k of order) {
      const p = parseMap(replies[k]);
      const z = where[k];
      for (const s of p.set.slice(0, 2)) {
        if (col[s.i] == null || s.c < 0) continue;
        if (m.areaOf[s.i] !== z) { obs.out_of_area++; continue; }
        const before = areaConflicts(m, col, z);
        const overwrites = !!(setBy[s.i] && setBy[s.i] !== agents[k].id && col[s.i] !== s.c);
        if (overwrites) obs.overwrites_of_others++;
        const prev = new Map(m.adj[s.i].map(j => [j, col[j] === col[s.i]]));
        col[s.i] = s.c; setBy[s.i] = agents[k].id;
        for (const j of m.adj[s.i]) {
          const key = s.i < j ? `${s.i}-${j}` : `${j}-${s.i}`;
          const now = col[j] === col[s.i];
          if (!prev.get(j) && now) madeBy.set(key, true);
          if (prev.get(j) && !now && madeBy.get(key)) { obs.conflicts_undone++; madeBy.delete(key); }
        }
        // Reuse: fixing a conflict while keeping what others set in the area.
        if (!overwrites && areaConflicts(m, col, z) < before && m.areas[z].some(i => setBy[i] && setBy[i] !== agents[k].id)) obs.reuse++;
      }
      if (marksOn && p.mark && (p.mark.z === z || m.areaAdj[z].includes(p.mark.z)) && p.mark.text) {
        const list = marks[p.mark.z];
        const mine = list.find(x => x.by === agents[k].id);
        if (mine) { mine.s += p.mark.s; mine.text = p.mark.text; } else list.push({ s: p.mark.s, text: p.mark.text, by: agents[k].id });
        list.sort((a, b) => b.s - a.s).splice(3);
        obs.marks_left++;
        if (quotes.length < 2 && p.mark.text.split(' ').length >= 3) quotes.push(p.mark.text);
      }
      if (p.go != null && (p.go === z || m.areaAdj[z].includes(p.go))) {
        if (marksOn && p.go !== z && marks[p.go].length) obs.marks_followed++;
        where[k] = p.go;
      }
    }
    for (const list of marks) { for (const x of list) x.s *= 0.6; list.splice(0, list.length, ...list.filter(x => x.s >= 0.3)); }
    const counts = {}; where.forEach((z, k) => { if (active[k]) counts[z] = (counts[z] || 0) + 1; });
    obs.converged_agents = Math.max(obs.converged_agents, ...Object.values(counts));
    if (solvedAt == null && conflicts(m, col) === 0) solvedAt = t + 1;
    if (solvedAt != null) break;
  }
  obs.converged_at_tick = solvedAt;
  obs.quotes = quotes;
  symmetry(obs, agents, visits, spread, zones, koAt);
  return { col, starter };
}

async function mapBoss(m, boss, workers, rounds, call, obs) {
  const col = [...m.start];
  const reports = workers.map(() => '');
  const orders = workers.map((_, k) => ({ z: k % m.areas.length, text: '' }));
  Object.assign(obs, { boss_call_share: 0, instructions: 0, instructions_followed: 0 });
  const quotes = [];
  let bossCalls = 0, workerCalls = 0;
  for (let t = 0; t < rounds; t++) {
    if (conflicts(m, col) === 0) break;
    const summary = m.areas.map((ns, z) => `area ${z + 1}: regions ${ns.map(i => i + 1).join(', ')}; conflicts ${areaConflicts(m, col, z)}`);
    const prompt = [MAP_RULES(m), '', `You lead ${workers.length} workers (W1 to W${workers.length}). Each round you give every worker one area and one short instruction. Workers change regions; you don't, and you don't see the regions themselves.`, '',
      `Round ${t + 1} of ${rounds}. Conflicts now: ${conflicts(m, col)}.`, ...summary, '',
      'Last reports:', ...workers.map((w, k) => `W${k + 1} (area ${orders[k].z + 1}): ${reports[k] || '(none yet)'}`), '',
      'Reply with one line per worker:', 'W<n> <area> <instruction, up to 12 words>'].join('\n');
    const p = parseMap(await call(boss, `t${t + 1}-boss`, prompt));
    bossCalls++;
    for (const o of p.orders) if (workers[o.w] && m.areas[o.z]) { orders[o.w] = { z: o.z, text: o.text }; obs.instructions++; if (quotes.length < 2 && o.text) quotes.push(o.text); }
    const replies = await pool(workers, PARALLEL(), (w, k) => call(w, `t${t + 1}-${w.id}`, [MAP_RULES(m), '',
      `You are worker W${k + 1}. Your lead gave you area ${orders[k].z + 1}${orders[k].text ? ` and this instruction: "${orders[k].text}"` : ''}.`, '',
      'Regions in your area:', ...m.areas[orders[k].z].map(i => regionLine(m, col, i)), '',
      'Reply with these lines only:', 'SET <region> <colour>   (0 to 2 lines, regions in your area only)', 'REPORT <up to 12 words for your lead>'].join('\n')));
    workerCalls += workers.length;
    replies.forEach((text, k) => {
      const q = parseMap(text);
      let ok = 0;
      for (const s of q.set.slice(0, 2)) if (col[s.i] != null && s.c >= 0 && m.areaOf[s.i] === orders[k].z) { col[s.i] = s.c; ok++; }
      if (ok && orders[k].text) obs.instructions_followed++;
      reports[k] = q.report;
    });
  }
  obs.boss_call_share = r1(100 * bossCalls / Math.max(1, bossCalls + workerCalls));
  obs.quotes = quotes;
  return { col };
}

// ---- Nest arms ----

async function nestSolo(nest, agent, budget, inspectBudget, call, r) {
  const seen = [shuffle([...Array(nest.n).keys()], r)[0]];
  let final = null, used = 0;
  for (; used < budget && final == null; used++) {
    const last = used === budget - 1;
    const left = last ? 0 : inspectBudget - seen.length;
    const prompt = [NEST_RULES(nest), '', `You work alone. Call ${used + 1} of at most ${budget}. ${last ? 'This is your last call: choose now.' : `Inspections left: ${left}.`}`, '',
      'Sites you have inspected:', ...seen.map(i => siteLine(nest, i)), '',
      'Reply with one line only:', left > 0 ? 'INSPECT <site>   (you see its numbers next call)' : null, 'FINAL <site>   (the colony moves there; this ends the task)'].filter(Boolean).join('\n');
    const p = parseNest(await call(agent, `solo-${String(used + 1).padStart(2, '0')}`, prompt));
    if (p.final != null && nest.sites[p.final]) final = p.final;
    else if (p.inspect != null && nest.sites[p.inspect] && left > 0 && !seen.includes(p.inspect)) seen.push(p.inspect);
  }
  return { chosen: final, moves: used, inspections: seen.length };
}

async function nestSwarm(nest, agents, rounds, mode, inspectBudget, call, r, obs, opts = {}) {
  // mode: 'marks' | 'no-marks' | 'imitation'
  const k = agents.length, quorum = Math.ceil(k / 2);
  const firstSites = shuffle([...Array(nest.n).keys()], r);
  const canInspect = agents.map((_, a) => mode !== 'imitation' || a < 2);
  // start "same": no scout has seen any site yet.
  const seen = agents.map((_, a) => canInspect[a] && opts.start !== 'same' ? [firstSites[a % nest.n]] : []);
  const active = agents.map(() => true);
  const visits = agents.map(() => []);
  const spread = [];
  const koAt = opts.knockout && rounds >= 2 ? Math.floor(rounds / 2) : null;
  const pending = agents.map(() => null);
  const board = {}; // site -> { s, said: [] }
  const vote = agents.map(() => null);
  let chosen = null, starter = null;
  Object.assign(obs, { dances: 0, dances_followed: 0, converged_agents: 0, converged_at_tick: null, quorum: false, inspections: 0 });
  const boardLines = () => { const rows = Object.entries(board).filter(([, b]) => b.s >= 0.3).sort((a, b) => b[1].s - a[1].s);
    return rows.length ? rows.map(([i, b]) => `site ${Number(i) + 1}: strength ${b.s.toFixed(1)}, scores said ${b.said.slice(-3).join(', ')}`) : ['(no dances yet)']; };
  for (let t = 0; t < rounds && chosen == null; t++) {
    for (let a = 0; a < k; a++) if (pending[a] != null) { seen[a].push(pending[a]); visits[a].push(pending[a]); pending[a] = null; }
    if (t === koAt) { active[0] = false; vote[0] = null; obs.knockout = { round: t + 1, agent: agents[0].id }; }
    const prompts = agents.map((ag, a) => {
      const left = canInspect[a] ? inspectBudget - seen[a].length : 0;
      return [NEST_RULES(nest), '',
        `You are one of ${k} scouts. Nobody is in charge and there is no chat.${mode !== 'no-marks' ? ' Scouts advertise sites on a dance board; a dance fades every round unless renewed.' : ''} The colony moves as soon as ${quorum} scouts vote for the same site in the same round.`, '',
        `Round ${t + 1} of ${rounds}.${canInspect[a] ? ` Inspections left: ${left}.` : ' You cannot inspect sites: you can only follow the dances.'}`,
        'Sites you have inspected:', ...(seen[a].length ? seen[a].map(i => siteLine(nest, i)) : ['(none)']),
        vote[a] != null ? `Your current vote: site ${vote[a] + 1}.` : null, '',
        mode !== 'no-marks' ? 'Dance board:' : null, ...(mode !== 'no-marks' ? boardLines() : []), '',
        'Reply with these lines only (each one optional):',
        left > 0 ? 'INSPECT <site>   (you see its numbers next round)' : null,
        mode !== 'no-marks' ? 'DANCE <site> <quality you computed>' : null,
        'VOTE <site>   (the site you back now)'].filter(x => x != null).join('\n');
    });
    const replies = await pool(agents, PARALLEL(), (ag, a) => active[a] ? call(ag, `t${t + 1}-${ag.id}`, prompts[a]) : '');
    const order = shuffle(agents.map((_, a) => a), r).filter(a => active[a]);
    if (t === 0) starter = agents[order[0]].id;
    for (const b of Object.values(board)) b.s *= 0.6;
    for (const a of order) {
      const p = parseNest(replies[a]);
      const left = canInspect[a] ? inspectBudget - seen[a].length : 0;
      if (p.inspect != null && nest.sites[p.inspect] && left > 0 && !seen[a].includes(p.inspect)) { pending[a] = p.inspect; obs.inspections++; }
      if (mode !== 'no-marks' && p.dance && nest.sites[p.dance.i]) {
        const b = board[p.dance.i] ??= { s: 0, said: [] };
        b.s += 1; b.said.push(p.dance.q); obs.dances++;
        if (!seen[a].includes(p.dance.i)) obs.dances_followed++;
      }
      if (p.vote != null && nest.sites[p.vote]) { vote[a] = p.vote; if (!seen[a].includes(p.vote) && mode !== 'no-marks') obs.dances_followed++; }
    }
    const tally = {}; for (const v of vote) if (v != null) tally[v] = (tally[v] || 0) + 1;
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    if (top) obs.converged_agents = Math.max(obs.converged_agents, top[1]);
    spread.push(new Set(vote.filter((v, a) => active[a] && v != null)).size);
    if (top && top[1] >= quorum) { chosen = Number(top[0]); obs.quorum = true; obs.converged_at_tick = t + 1; }
  }
  if (chosen == null) { // no quorum: the most backed site, if any
    const tally = {}; for (const v of vote) if (v != null) tally[v] = (tally[v] || 0) + 1;
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    chosen = top ? Number(top[0]) : null;
  }
  obs.wrong_cascade = obs.quorum && chosen !== nest.bestSite;
  symmetry(obs, agents, visits, spread, nest.n, koAt);
  obs.spread_by_round_means = 'distinct sites voted for';
  return { chosen, starter };
}

async function nestBoss(nest, boss, workers, rounds, inspectBudget, call, r, obs) {
  const reports = [];
  const done = workers.map(() => 0);
  let chosen = null, bossCalls = 0, workerCalls = 0;
  Object.assign(obs, { boss_call_share: 0, instructions: 0, instructions_followed: 0 });
  const quotes = [];
  for (let t = 0; t < rounds && chosen == null; t++) {
    const prompt = [NEST_RULES(nest), '', `You lead ${workers.length} workers (W1 to W${workers.length}). You can't inspect sites; workers can, ${inspectBudget} each, and report the quality they computed. You decide.`, '',
      `Round ${t + 1} of ${rounds}.`, 'Reports so far:', ...(reports.length ? reports : ['(none yet)']), '',
      'Inspections left: ' + workers.map((_, k) => `W${k + 1} ${inspectBudget - done[k]}`).join(', '), '',
      'Reply with these lines only:', 'W<n> <site>   (send worker n to inspect a site; one line per worker you send)', 'DECIDE <site>   (instead, when you are sure: the colony moves there)'].join('\n');
    const p = parseNest(await call(boss, `t${t + 1}-boss`, prompt));
    bossCalls++;
    if (p.decide != null && nest.sites[p.decide]) { chosen = p.decide; break; }
    const jobs = [];
    for (const o of p.orders) if (workers[o.w] && nest.sites[o.i] && done[o.w] < inspectBudget && !jobs.some(j => j.k === o.w)) { jobs.push({ k: o.w, i: o.i }); obs.instructions++; }
    const replies = await pool(jobs, PARALLEL(), j => call(workers[j.k], `t${t + 1}-${workers[j.k].id}`, [NEST_RULES(nest), '',
      `You are worker W${j.k + 1}. Your lead sent you to inspect site ${j.i + 1}:`, siteLine(nest, j.i), '',
      'Reply with one line only:', 'REPORT <quality you computed> <up to 12 words for your lead>'].join('\n')));
    workerCalls += jobs.length;
    jobs.forEach((j, n) => {
      done[j.k]++;
      const q = parseNest(replies[n]).report;
      if (q) { obs.instructions_followed++; reports.push(`W${j.k + 1} on site ${j.i + 1}: quality ${q.q}${q.text ? `, "${q.text}"` : ''}`); if (quotes.length < 2 && q.text) quotes.push(q.text); }
    });
  }
  obs.boss_call_share = r1(100 * bossCalls / Math.max(1, bossCalls + workerCalls));
  obs.quotes = quotes;
  return { chosen, calls: bossCalls + workerCalls };
}

// ---- Arms and cells ----

function arms(cfg, task) {
  const k = cfg.swarm;
  const list = [
    { id: 'solo-strong', kind: 'solo', strong: true },
    { id: 'solo-small', kind: 'solo' },
    ...(task === 'map' ? [{ id: `best-of-${k}-isolated`, kind: 'isolated', k }] : []),
    { id: 'swarm-marks', kind: 'swarm', mode: 'marks', k },
    { id: 'swarm-no-marks', kind: 'swarm', mode: 'no-marks', k },
    ...(task === 'nest' ? [{ id: 'swarm-imitation-only', kind: 'swarm', mode: 'imitation', k }] : []),
    { id: 'boss-workers', kind: 'boss', k },
    ...(cfg.scale || []).map(n => ({ id: `swarm-marks-${n}`, kind: 'swarm', mode: 'marks', k: n })),
    // Symmetry breaking (design section 11): everyone starts in the same place.
    ...(cfg.symmetry ? [
      { id: 'swarm-marks-same', kind: 'swarm', mode: 'marks', k, start: 'same' },
      { id: 'swarm-no-marks-same', kind: 'swarm', mode: 'no-marks', k, start: 'same' },
      { id: 'swarm-marks-same-knockout', kind: 'swarm', mode: 'marks', k, start: 'same', knockout: true },
    ] : []),
  ];
  return list;
}

async function runCell(cfg, all, task, arm, rep) {
  const base = path.join(HOME_DIR, 'bench', cfg.run);
  const cellFile = path.join(base, 'cells', task, arm.id, `r${rep}.json`);
  if (fs.existsSync(cellFile) && !cfg.force) { console.log(`= ${task}/${arm.id}/r${rep}: kept`); return JSON.parse(fs.readFileSync(cellFile, 'utf8')); }
  const dir = path.join(base, 'swarm', task, arm.id, `r${rep}`);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`▶ ${task}/${arm.id}/r${rep}`);
  const family = cfg.small[(rep - 1) % cfg.small.length];
  const smalls = n => Array.from({ length: n }, (_, i) => resolveAgent(all, `${family}#${i + 1}`));
  const seed = cfg.seed * 1000 + rep;
  const r = rng(seed + arm.id.length * 31 + (task === 'nest' ? 7 : 0));
  const stats = { calls: 0, tokens: 0, failures: 0 };
  const call = caller(dir, stats);
  const budget = cfg.budget, rounds = n => Math.max(1, Math.round(budget / n));
  const t0 = Date.now(), since = new Date().toISOString();
  const obs = {};
  let score, models, starter = null, history = {};
  if (task === 'map') {
    const m = makeMap(seed, cfg.map.regions, cfg.map.area);
    obs.conflicts_start = conflicts(m, m.start);
    let col;
    if (arm.kind === 'solo') {
      const agent = arm.strong ? resolveAgent(all, cfg.strong) : resolveAgent(all, family);
      const out = await mapSolo(m, agent, budget, call);
      col = out.col; obs.moves = out.moves; models = [agent.model || agent.id];
    } else if (arm.kind === 'isolated') {
      const ags = smalls(arm.k);
      const outs = await pool(ags, PARALLEL(), a => mapSolo(m, a, rounds(arm.k), call, a.id));
      const scores = outs.map(o => mapScore(m, o.col));
      col = outs[scores.indexOf(Math.max(...scores))].col;
      Object.assign(obs, { mean_score: r1(scores.reduce((a, b) => a + b, 0) / scores.length), distinct_finals: new Set(outs.map(o => o.col.join(''))).size, solved: scores.filter(s => s === 100).length, quotes: [] });
      models = [ags[0].model];
    } else if (arm.kind === 'swarm') {
      const ags = smalls(arm.k);
      const out = await mapSwarm(m, ags, rounds(arm.k), arm.mode === 'marks', call, r, obs, arm);
      col = out.col; starter = out.starter; models = [ags[0].model];
    } else {
      const ags = smalls(arm.k);
      const out = await mapBoss(m, ags[0], ags.slice(1), rounds(arm.k), call, obs);
      col = out.col; starter = ags[0].id; models = [ags[0].model];
    }
    obs.conflicts_end = conflicts(m, col);
    score = mapScore(m, col);
    history = { start: m.start, final: col, hidden: m.hidden, areas: m.areas };
  } else {
    const nest = makeNest(seed, cfg.nest.sites);
    const insp = cfg.nest.inspect;
    let chosen;
    if (arm.kind === 'solo') {
      const agent = arm.strong ? resolveAgent(all, cfg.strong) : resolveAgent(all, family);
      const out = await nestSolo(nest, agent, budget, insp * cfg.swarm, call, r);
      chosen = out.chosen; Object.assign(obs, { moves: out.moves, inspections: out.inspections, quotes: [] }); models = [agent.model || agent.id];
    } else if (arm.kind === 'swarm') {
      const ags = smalls(arm.k);
      const out = await nestSwarm(nest, ags, rounds(arm.k), arm.mode, insp, call, r, obs, arm);
      chosen = out.chosen; starter = out.starter; models = [ags[0].model];
      obs.quotes ??= [];
    } else {
      const ags = smalls(arm.k);
      const out = await nestBoss(nest, ags[0], ags.slice(1), rounds(arm.k), insp, call, r, obs);
      chosen = out.chosen; starter = ags[0].id; models = [ags[0].model];
    }
    Object.assign(obs, { chosen: chosen == null ? null : chosen + 1, best: nest.bestSite + 1, chosen_quality: chosen == null ? null : nest.sites[chosen].q, best_quality: nest.best });
    score = nestScore(nest, chosen);
    history = { sites: nest.sites };
  }
  obs.failures = stats.failures;
  obs.quotes ??= [];
  const usesOR = !arm.strong && cfg.small.some(s => s.startsWith('openrouter:'));
  let cost = null;
  if (!arm.strong && family.startsWith('local:')) cost = 0;
  else if (usesOR) cost = r1(require('./openrouter').spent(since) * USD_GBP * 100) / 100;
  const cell = { task, config: arm.id, repeat: rep, score: r1(score), calls: stats.calls, seconds: Math.round((Date.now() - t0) / 1000), tokens_est: stats.tokens,
    cost_gbp: cost, models, family, starter, observations: obs, source: dir };
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(history));
  fs.mkdirSync(path.dirname(cellFile), { recursive: true });
  fs.writeFileSync(cellFile, JSON.stringify(cell, null, 1));
  console.log(`  ${task}/${arm.id}/r${rep}: score ${cell.score}, ${cell.calls} calls, ${cell.seconds}s`);
  return cell;
}

async function main(file, opts = {}) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = { run: 'bench-v1', budget: 60, swarm: 12, repeats: 4, seed: 10, scale: [], ...raw, force: !!opts.force };
  cfg.map = { regions: 60, area: 5, ...(raw.map || {}) };
  cfg.nest = { sites: 30, inspect: 2, ...(raw.nest || {}) };
  if (!Array.isArray(cfg.small) || !cfg.small.length) throw new Error('"small": [model, ...] is required');
  const all = loadConfig().agents;
  const tasks = opts.tasks || cfg.tasks || ['map', 'nest'];
  const cells = [];
  for (let rep = 1; rep <= cfg.repeats; rep++)
    for (const task of tasks)
      for (const arm of arms(cfg, task))
        if (!opts.arms || opts.arms.includes(arm.id)) cells.push(await runCell(cfg, all, task, arm, rep));
  console.log(`Cells: ${path.join(HOME_DIR, 'bench', cfg.run, 'cells')}`);
  return cells;
}

module.exports = { makeMap, makeNest, conflicts, mapScore, nestScore, parseMap, parseNest, arms, main };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const file = argv.find(a => a.endsWith('.json'));
  if (!file) { console.error('usage: node swarm.js <swarm.json> [--tasks map,nest] [--arms a,b] [--force]'); process.exit(2); }
  main(file, { tasks: opt('--tasks')?.split(','), arms: opt('--arms')?.split(','), force: argv.includes('--force') })
    .catch(e => { console.error(e.message); process.exit(1); });
}
