#!/usr/bin/env node
// @ts-check
// Experiment C, "the crowd that watches": `node crowd.js <crowd.json> [--family local:qwen3:8b,...] [--until HH:MM] [--force]`.
//
// 32 identical copies of one small local model each see a different small
// part of some hidden data and estimate one number about the whole: how many
// "#" are in a hidden 60x60 grid (each copy sees a 6x10 window), or the mean
// of 2,000 hidden skewed numbers (each copy sees 12 of them). The script
// knows the true value. Round 1: each copy estimates alone. Rounds 2 and 3:
// each copy sees its own last estimate and, depending on the arm, the last
// estimates of other copies, and estimates again.
//
// Arms (the same questions, the same private parts and the same round 1 for
// every arm: round 1 is called once, in "isolated", and shared):
//  isolated  no one else's estimate; "look again"       control: asked again, same calls
//  full      every copy sees the other 31
//  sparse    every copy sees 4 neighbours (a ring, random places)
//  star      one copy, picked at random, sees all; the others see only it
//  calib     round 2 only: each copy sees 4 estimates written by the script
//            (true x 0.6, 0.8, 1.25, 1.5): the weight it gives others, from
//            which the script predicts the three networks with no calls
// Odd questions show other estimates in digits, even ones in words
// ("four hundred and twelve"): the same information, described differently.
//
// Measures (pre-registered in lab/influence-plan.md, 20 Nov 2026, before any
// run): crowd error |mean - true| / true per round and its change from round 1
// to 3; diversity (standard deviation / true) and its ratio round 3 / round 1;
// confidence-accuracy rank correlation in round 1; the pull of the star's
// centre. The unit is the question; differences between arms are taken
// question by question, then averaged, with a 95% interval from resampling
// the questions. Hypotheses H1-H5 are judged in summary.md only once a
// family has all its questions (no peeking).
//
// Gate: after the first 2 questions of "isolated", a family goes on only if
// 90% of replies are readable and round-1 diversity is above 0.02.
//
// Config: { "run": "c1", "families": ["local:qwen3:8b", "local:gemma3:12b"],
//   "agents": 32, "questions": 16, "rounds": 3, "seed": 22 }
// Out: ~/.agent-dispatch/crowd/<run>/cells/<family>/<arm>/q<N>.json, every
// prompt and reply next to them, and summary.md (rewritten after every cell).
// Cells already there are kept, so the same command carries on where it
// stopped. Agents only write text, which this script parses.

const fs = require('fs');
const path = require('path');
const { HOME_DIR, loadConfig } = require('./config');
const { resolveAgent } = require('./room');
const { run } = require('./motion');

const ARMS = ['isolated', 'full', 'sparse', 'star'];
const PARALLEL = () => Math.max(1, Number(process.env.CROWD_PARALLEL) || 4);
const MAX_FAILS = () => Number(process.env.CROWD_MAX_FAILS_IN_A_ROW) || 6;
const CALIB = [0.6, 0.8, 1.25, 1.5];
const GRID = 60, WIN_R = 6, WIN_C = 10, LIST_N = 2000, LIST_SHOW = 12;

function rng(seed) { let s = (Math.abs(Math.floor(seed)) % 2147483646) + 1; return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }
function shuffle(xs, r) { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const r3 = x => x == null || Number.isNaN(x) ? null : Math.round(x * 1000) / 1000;
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const sd = xs => { const m = mean(xs); return xs.length > 1 && m != null ? Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)) : null; };
const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const slug = s => String(s).replace(/^local:/, '').replace(/[^a-z0-9.]+/gi, '-');

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ---- Numbers in words ----

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function under1000(n) {
  const h = Math.floor(n / 100), rest = n % 100;
  const tail = rest < 20 ? ONES[rest] : TENS[Math.floor(rest / 10)] + (rest % 10 ? `-${ONES[rest % 10]}` : '');
  if (!h) return tail;
  return `${ONES[h]} hundred${rest ? ` and ${tail}` : ''}`;
}
function inWords(x) {
  let n = Math.round(Math.abs(Number(x)));
  if (!Number.isFinite(n)) return String(x);
  if (n === 0) return 'zero';
  const parts = [];
  for (const [size, name] of /** @type {[number, string][]} */ ([[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']])) {
    if (n >= size) { parts.push(`${under1000(Math.floor(n / size) % 1000)} ${name}`); n %= size; }
  }
  if (n) parts.push(parts.length && n < 100 ? `and ${under1000(n)}` : under1000(n));
  return (x < 0 ? 'minus ' : '') + parts.join(' ');
}

// ---- Questions ----

function gauss(r) { return Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r()); }

// A grid with denser and emptier zones, so private windows really differ.
function makeGrid(r) {
  const base = 0.05 + r() * 0.15;
  const blobs = Array.from({ length: 3 }, () => ({ x: r() * GRID, y: r() * GRID, rad: 6 + r() * 12, d: 0.2 + r() * 0.4 }));
  const g = [];
  for (let y = 0; y < GRID; y++) {
    let row = '';
    for (let x = 0; x < GRID; x++) {
      const p = Math.min(0.95, base + blobs.reduce((a, b) => a + (Math.hypot(x - b.x, y - b.y) < b.rad ? b.d : 0), 0));
      row += r() < p ? '#' : '.';
    }
    g.push(row);
  }
  return g;
}

// Question q (1-based): types go grid, grid, list, list, ...; odd q digits, even q words.
function makeQuestion(seed, q, agents) {
  const r = rng(seed * 1009 + q * 31);
  const type = Math.floor((q - 1) / 2) % 2 === 0 ? 'grid' : 'list';
  const format = q % 2 ? 'digits' : 'words';
  if (type === 'grid') {
    const g = makeGrid(r);
    const truth = g.join('').split('').filter(c => c === '#').length;
    const parts = Array.from({ length: agents }, () => {
      const y = Math.floor(r() * (GRID - WIN_R + 1)), x = Math.floor(r() * (GRID - WIN_C + 1));
      return g.slice(y, y + WIN_R).map(row => row.slice(x, x + WIN_C)).join('\n');
    });
    return { q, type, format, truth, parts,
      what: `a grid of ${GRID} rows and ${GRID} columns (${GRID * GRID} cells); each cell is "#" or "."`,
      shown: `a window of ${WIN_R} rows and ${WIN_C} columns, at a random place in the grid`,
      ask: `how many "#" there are in the whole grid of ${GRID * GRID} cells`, thing: 'grid' };
  }
  const mu = 3 + r() * 3, sig = 0.8 + r() * 0.6;
  const xs = Array.from({ length: LIST_N }, () => Math.max(1, Math.round(Math.exp(mu + sig * gauss(r)))));
  const truth = Math.round(mean(xs) * 10) / 10;
  const parts = Array.from({ length: agents }, () => shuffle(xs.map((_, i) => i), r).slice(0, LIST_SHOW).map(i => xs[i]).join(', '));
  return { q, type, format, truth, parts,
    what: `a list of ${LIST_N} whole numbers`,
    shown: `${LIST_SHOW} numbers taken at random from the list`,
    ask: `the average (mean) of all ${LIST_N} numbers in the list`, thing: 'list' };
}

// ---- Networks ----

// Who each copy sees, per arm. Places on the ring and the star's centre come
// from the seed and the question, not from what anyone answered.
function network(arm, agents, seed, q) {
  const r = rng(seed * 7919 + q * 17);
  const place = shuffle([...Array(agents).keys()], r); // place[i] = agent at ring position i
  const at = []; place.forEach((a, i) => { at[a] = i; });
  const all = [...Array(agents).keys()];
  if (arm === 'isolated') return { sees: all.map(() => []), centre: null };
  if (arm === 'full') return { sees: all.map(a => all.filter(b => b !== a)), centre: null };
  if (arm === 'sparse') return { sees: all.map(a => [-2, -1, 1, 2].map(d => place[(at[a] + d + agents) % agents]).filter((b, i, xs) => b !== a && xs.indexOf(b) === i)), centre: null };
  if (arm === 'star') { const c = place[0]; return { sees: all.map(a => a === c ? all.filter(b => b !== c) : [c]), centre: c }; }
  if (arm === 'calib') return { sees: all.map(() => []), centre: null };
  throw new Error(`unknown arm ${arm}`);
}

// ---- Prompts and replies ----

const show = (x, format) => format === 'words' ? inWords(x) : String(Math.round(x));

function prompt(Q, a, round, own, others) {
  const L = [`There is ${Q.what}. It is hidden from you. You are shown only ${Q.shown}:`, '', Q.parts[a], '',
    `Estimate ${Q.ask}.`];
  if (round > 1) {
    L.push('', own == null ? 'You gave no readable estimate last round.' : `Your estimate last round was ${show(own, Q.format)}.`);
    const seen = others.filter(x => x != null);
    if (seen.length) L.push(`${seen.length === 1 ? 'One other agent like you, shown a different random part of the same hidden ' + Q.thing + ', estimated' : `Other agents like you, each shown a different random part of the same hidden ${Q.thing}, estimated`} last round: ${seen.map(x => show(x, Q.format)).join('; ')}.`);
    L.push(seen.length ? 'Give your estimate now.' : 'Look at your part again and give your estimate now.');
  }
  L.push('', 'Reply with these two lines only:', 'ESTIMATE <a number>', 'CONFIDENCE <0 to 100: how sure you are that your estimate is within 10% of the true value>');
  return L.join('\n');
}

function parseReply(text) {
  const out = { estimate: null, confidence: null };
  for (const l of String(text).split('\n')) {
    let m;
    if (out.estimate == null && (m = l.match(/ESTIMATE\W*([-+]?[\d,]*\.?\d+)/i))) {
      const v = Number(m[1].replace(/,/g, ''));
      if (Number.isFinite(v) && v >= 0) out.estimate = v;
    } else if (out.confidence == null && (m = l.match(/CONFIDENCE\W*(\d+(?:\.\d+)?)/i))) {
      const v = Number(m[1]);
      if (v >= 0 && v <= 100) out.confidence = v;
    }
  }
  return out;
}

// ---- Calls ----

class NotAnswering extends Error {}
const streak = { fails: 0 };
function caller(dir, stats) {
  const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  return async (agent, file, text) => {
    if (streak.fails >= MAX_FAILS()) throw new NotAnswering(`${streak.fails} calls in a row failed`);
    stats.calls++;
    const t0 = Date.now();
    try {
      const out = await run(dir, file, agent, text, cwd);
      stats.seconds.push((Date.now() - t0) / 1000);
      streak.fails = 0;
      return out;
    } catch (e) {
      stats.failures++; streak.fails++;
      console.warn(`  ✗ ${file}: ${String(e.message).split('\n')[0]}`);
      if (streak.fails >= MAX_FAILS()) throw new NotAnswering(`${streak.fails} calls in a row failed, last: ${String(e.message).split('\n')[0]}`);
      return '';
    }
  };
}

// ---- One cell: one family, one arm, one question ----

async function runCell(cfg, all, family, arm, q, round1) {
  const base = path.join(HOME_DIR, 'crowd', cfg.run);
  const cellFile = path.join(base, 'cells', slug(family), arm, `q${q}.json`);
  if (fs.existsSync(cellFile) && !cfg.force) return JSON.parse(fs.readFileSync(cellFile, 'utf8'));
  if (arm !== 'isolated' && !round1) return null;
  const dir = path.join(base, 'runs', slug(family), arm, `q${q}`);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`▶ ${slug(family)} ${arm} q${q}`);
  const Q = makeQuestion(cfg.seed, q, cfg.agents);
  const net = network(arm, cfg.agents, cfg.seed, q);
  const agents = Array.from({ length: cfg.agents }, (_, i) => resolveAgent(all, `${family}#${i + 1}`));
  const stats = { calls: 0, failures: 0, seconds: /** @type {number[]} */ ([]) };
  const call = caller(dir, stats);
  const t0 = Date.now();
  const est = [], conf = [], readable = [];
  // "calib": in round 2 each copy sees 4 estimates written by the script (true x CALIB, shuffled per copy).
  const cr = rng(cfg.seed * 389 + q * 7);
  const scripted = cfg.agents ? Array.from({ length: cfg.agents }, () => shuffle(CALIB, cr).map(f => Q.truth * f)) : [];
  const ask = async t => {
    const replies = await pool(agents, PARALLEL(), (a, k) => call(a, `t${t + 1}-a${k + 1}`,
      prompt(Q, k, t + 1, t ? est[t - 1][k] : null, !t ? [] : arm === 'calib' ? scripted[k] : net.sees[k].map(b => est[t - 1][b]))));
    const p = replies.map(parseReply);
    readable.push(p.filter(x => x.estimate != null).length);
    // An unreadable reply keeps the copy's last estimate (null in round 1).
    est.push(p.map((x, k) => x.estimate ?? (t ? est[t - 1][k] : null)));
    conf.push(p.map(x => x.confidence));
  };
  if (arm === 'isolated') await ask(0);
  else { est.push(round1.estimates[0]); conf.push(round1.confidences[0]); readable.push(round1.readable[0]); }
  for (let t = 1; t < (arm === 'calib' ? 2 : cfg.rounds); t++) await ask(t);
  if (stats.failures > Math.max(1, Math.floor(stats.calls * 0.05))) {
    console.warn(`  ✗ ${arm} q${q}: ${stats.failures} of ${stats.calls} calls failed, cell not kept`);
    return null;
  }
  const cell = { family, arm, question: q, type: Q.type, format: Q.format, truth: Q.truth, agents: cfg.agents,
    centre: net.centre, scripted: arm === 'calib' ? scripted : undefined, estimates: est, confidences: conf, readable, calls: stats.calls, failures: stats.failures,
    seconds: Math.round((Date.now() - t0) / 1000), call_seconds_median: r3(median(stats.seconds)) };
  fs.mkdirSync(path.dirname(cellFile), { recursive: true });
  fs.writeFileSync(cellFile, JSON.stringify(cell));
  const m = measures(cell);
  console.log(`  error ${m.error[0]} -> ${m.error[m.error.length - 1]}, diversity ${m.diversity[0]} -> ${m.diversity[m.diversity.length - 1]}, ${cell.calls} calls, ${cell.seconds}s`);
  return cell;
}

// ---- Measures ----

function ranks(xs) {
  const idx = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}
function spearman(xs, ys) {
  if (xs.length < 5) return null;
  const a = ranks(xs), b = ranks(ys), ma = mean(a), mb = mean(b);
  const num = a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0);
  const den = Math.sqrt(a.reduce((s, x) => s + (x - ma) ** 2, 0) * b.reduce((s, y) => s + (y - mb) ** 2, 0));
  return den ? num / den : null;
}

function measures(cell) {
  const T = cell.truth;
  const live = cell.estimates.map(row => row.filter(x => x != null));
  const error = live.map(xs => r3(xs.length ? Math.abs(mean(xs) - T) / T : null));
  const error_median = live.map(xs => r3(xs.length ? Math.abs(median(xs) - T) / T : null));
  const diversity = live.map(xs => r3(xs.length > 1 ? sd(xs) / T : null));
  const last = error.length - 1;
  const pairs = cell.estimates[0].map((x, k) => [x, cell.confidences[0][k]]).filter(([x, c]) => x != null && c != null);
  const conf_acc = r3(spearman(pairs.map(p => p[1]), pairs.map(p => -Math.abs(p[0] - T))));
  let pull = null;
  if (cell.centre != null && live[0].length && live[last].length) {
    const c0 = cell.estimates[0][cell.centre], m0 = mean(live[0]), m3 = mean(live[last]);
    if (c0 != null && Math.abs(c0 - m0) > T * 0.01) pull = r3((m3 - m0) / (c0 - m0));
  }
  return { error, error_median, diversity, d_error: error[last] != null && error[0] != null ? r3(error[last] - error[0]) : null,
    div_ratio: diversity[last] != null && diversity[0] ? r3(diversity[last] / diversity[0]) : null, conf_acc, pull };
}

// Mean of per-question values with a 95% interval from resampling the questions.
function boot(vals, seed = 1, n = 2000) {
  const xs = vals.filter(x => x != null && Number.isFinite(x));
  if (!xs.length) return { mean: null, lo: null, hi: null, n: 0 };
  const r = rng(seed);
  const ms = Array.from({ length: n }, () => mean(xs.map(() => xs[Math.floor(r() * xs.length)]))).sort((a, b) => a - b);
  return { mean: r3(mean(xs)), lo: r3(ms[Math.floor(n * 0.025)]), hi: r3(ms[Math.floor(n * 0.975) - 1]), n: xs.length };
}
const includes0 = b => b.lo != null && b.lo <= 0 && b.hi >= 0;

// The pre-registered hypotheses, from one family's cells. Verdicts: holds / wrong / undecided.
function hypotheses(cells) {
  const by = {}; for (const c of cells) (by[c.arm] ??= {})[c.question] = measures(c);
  const qs = Object.keys(by.isolated || {}).filter(q => ARMS.every(a => by[a]?.[q]));
  const diff = (a, b, key) => qs.map(q => by[a][q][key] != null && by[b][q][key] != null ? by[a][q][key] - by[b][q][key] : null);
  const H = [];
  const h1 = boot(diff('isolated', 'full', 'div_ratio'), 11);
  H.push({ id: 'H1', text: 'diversity collapses: diversity ratio isolated − full', b: h1, verdict: h1.mean == null ? 'undecided' : h1.mean < 0.1 || includes0(h1) ? 'wrong' : 'holds' });
  const h2 = boot(diff('isolated', 'full', 'd_error'), 12);
  H.push({ id: 'H2', text: 'agreed but not more accurate: change in error isolated − full (positive = full improves more)', b: h2, verdict: h2.mean == null ? 'undecided' : h2.mean >= 0.02 && h2.lo > 0 ? 'wrong' : 'holds' });
  const h3 = boot(diff('sparse', 'full', 'div_ratio'), 13);
  H.push({ id: 'H3', text: 'sparse keeps diversity: diversity ratio sparse − full', b: h3, verdict: h3.mean == null ? 'undecided' : h3.mean < 0.1 || includes0(h3) ? 'wrong' : 'holds' });
  const h4 = boot(qs.map(q => by.isolated[q].conf_acc), 14);
  H.push({ id: 'H4', text: 'confidence does not follow accuracy: round-1 rank correlation', b: h4, verdict: h4.mean == null ? 'undecided' : h4.mean >= 0.3 && h4.lo > 0.2 ? 'wrong' : h4.mean < 0.2 ? 'holds' : 'undecided' });
  const h5 = boot(qs.map(q => by.star[q].pull), 15);
  H.push({ id: 'H5', text: 'the centre pulls: pull of the star centre', b: h5, verdict: h5.mean == null ? 'undecided' : h5.mean <= 0.1 ? 'wrong' : h5.mean > 0.3 ? 'holds' : 'undecided' });
  return { questions: qs.length, H };
}

function gate(cells) {
  const iso = cells.filter(c => c.arm === 'isolated');
  const replies = iso.reduce((a, c) => a + c.readable.length * c.agents, 0);
  const readable = replies ? iso.reduce((a, c) => a + c.readable.reduce((x, y) => x + y, 0), 0) / replies : 0;
  const div = mean(iso.map(c => measures(c).diversity[0]).filter(x => x != null));
  const why = [];
  if (readable < 0.9) why.push(`only ${Math.round(readable * 100)}% of replies readable (needs 90%)`);
  if (div == null || div <= 0.02) why.push(`round-1 diversity ${r3(div)} (needs above 0.02: the copies all say the same number)`);
  return { pass: why.length === 0, why, checks: { readable: r3(readable), diversity_round1: r3(div) } };
}

// Secondary, no extra calls: the round-1 crowd of 32 copies of one model
// against 16 + 16 of two models, on the same 32 private parts.
function mixed(cells, fams) {
  if (fams.length < 2) return null;
  const [a, b] = fams;
  const iso = f => Object.fromEntries(cells.filter(c => c.family === f && c.arm === 'isolated').map(c => [c.question, c]));
  const A = iso(a), B = iso(b);
  const rows = Object.keys(A).filter(q => B[q]).map(q => {
    const T = A[q].truth, ea = A[q].estimates[0], eb = B[q].estimates[0], h = ea.length >> 1;
    const err = xs => { const l = xs.filter(x => x != null); return l.length ? Math.abs(mean(l) - T) / T : null; };
    return { q: Number(q), a: err(ea), b: err(eb), mix: err([...ea.slice(0, h), ...eb.slice(h)]) };
  });
  return { a, b, n: rows.length, err_a: boot(rows.map(r => r.a), 21), err_b: boot(rows.map(r => r.b), 22), err_mix: boot(rows.map(r => r.mix), 23) };
}

// Steps 1 and 2 (added 20 Nov 21:20, before any run): the weight a copy gives
// the others, w = (new - own) / (mean of the 4 scripted - own), from "calib";
// then copies that follow exactly that rule (x + w * (mean seen - x)) run on
// the same networks from the same round 1, with no calls.
function weight(cells) {
  const ws = [];
  for (const c of cells.filter(x => x.arm === 'calib')) c.estimates[0].forEach((own, k) => {
    const now = c.estimates[1]?.[k], m = mean(c.scripted?.[k] || []);
    if (own == null || now == null || m == null || Math.abs(m - own) < c.truth * 0.05) return;
    ws.push((now - own) / (m - own));
  });
  return { w: ws.length ? r3(median(ws)) : null, n: ws.length };
}

function predicted(cell, w, seed, rounds) {
  const net = network(cell.arm, cell.agents, seed, cell.question);
  const est = [cell.estimates[0]];
  for (let t = 1; t < rounds; t++) est.push(est[t - 1].map((x, k) => {
    if (x == null) return null;
    const seen = net.sees[k].map(b => est[t - 1][b]).filter(v => v != null);
    return seen.length ? x + w * (mean(seen) - x) : x;
  }));
  return measures({ ...cell, estimates: est });
}

function prediction(cfg, cs) {
  const { w, n } = weight(cs);
  if (w == null) return null;
  const rows = ARMS.filter(a => a !== 'isolated').map(arm => {
    const ac = cs.filter(c => c.arm === arm);
    const pairs = ac.map(c => ({ real: measures(c), pred: predicted(c, w, cfg.seed, cfg.rounds) }));
    const gap = key => boot(pairs.map(p => p.real[key] != null && p.pred[key] != null ? p.real[key] - p.pred[key] : null), 31);
    return { arm, n: ac.length, pred_d_error: r3(mean(pairs.map(p => p.pred.d_error).filter(x => x != null))), pred_div: r3(mean(pairs.map(p => p.pred.div_ratio).filter(x => x != null))), gap_d_error: gap('d_error'), gap_div: gap('div_ratio') };
  });
  return { w, n, rows };
}

function summary(cfg, cells, gates) {
  const fmt = b => b.mean == null ? '—' : `${b.mean} [${b.lo}, ${b.hi}]`;
  const L = [`# Experiment C, the crowd that watches: ${cfg.run}`, '',
    `Written ${new Date().toISOString().slice(0, 16)}Z. Pre-registration: lab/influence-plan.md (20 Nov 2026). Design: room/collettivi-letteratura.md. Local models only, cost £0.`, ''];
  const fams = cfg.families.filter(f => cells.some(c => c.family === f));
  for (const f of fams) {
    const cs = cells.filter(c => c.family === f);
    const g = gates[f];
    L.push(`## ${slug(f)}`, '');
    if (g) L.push(`Gate: **${g.pass ? 'passed' : 'FAILED'}** ${JSON.stringify(g.checks)}${g.why.length ? ` because ${g.why.join('; ')}` : ''}`, '');
    L.push('| Arm | Questions | Error round 1 | Error last round | Change | Diversity ratio | Readable | Median seconds per call |', '|---|---|---|---|---|---|---|---|');
    for (const arm of ARMS) {
      const ac = cs.filter(c => c.arm === arm);
      if (!ac.length) continue;
      const ms = ac.map(measures);
      const rd = ac.reduce((a, c) => a + c.readable.slice(arm === 'isolated' ? 0 : 1).reduce((x, y) => x + y, 0), 0) / ac.reduce((a, c) => a + (c.readable.length - (arm === 'isolated' ? 0 : 1)) * c.agents, 0);
      L.push(`| ${arm} | ${ac.length} | ${r3(mean(ms.map(m => m.error[0]).filter(x => x != null)))} | ${r3(mean(ms.map(m => m.error[m.error.length - 1]).filter(x => x != null)))} | ${r3(mean(ms.map(m => m.d_error).filter(x => x != null)))} | ${r3(mean(ms.map(m => m.div_ratio).filter(x => x != null)))} | ${Math.round(rd * 100)}% | ${median(ac.map(c => c.call_seconds_median).filter(x => x != null)) ?? '—'} |`);
    }
    const h = hypotheses(cs);
    L.push('');
    if (h.questions < cfg.questions) L.push(`Hypotheses: not read until this family has all ${cfg.questions} questions in every arm (${h.questions} so far). No peeking.`);
    else {
      L.push(`**Hypotheses** (mean over ${h.questions} questions, 95% interval from resampling questions):`, '');
      for (const x of h.H) L.push(`- **${x.id}**, ${x.text}: ${fmt(x.b)}: **${x.verdict}**`);
      const pr = prediction(cfg, cs);
      if (pr) {
        L.push(`- **Prediction from the single copy** (secondary): weight given to others w = ${pr.w} (median of ${pr.n} copies in "calib"). Real minus predicted, mean [95%]:`);
        for (const x of pr.rows) L.push(`  - ${x.arm}: change in error ${fmt(x.gap_d_error)} (predicted ${x.pred_d_error}); diversity ratio ${fmt(x.gap_div)} (predicted ${x.pred_div})`);
      }
      for (const [key, vals] of /** @type {[string, string[]][]} */ ([['format', ['digits', 'words']], ['type', ['grid', 'list']]])) {
        const parts = vals.map(v => { const s = hypotheses(cs.filter(c => c[key] === v)); return `${v}: ${s.H.slice(0, 3).map(x => `${x.id} ${x.b.mean ?? '—'}`).join(', ')}`; });
        L.push(`- Split by ${key} (secondary): ${parts.join(' · ')}`);
      }
    }
    L.push('');
  }
  const mx = mixed(cells, fams);
  if (mx && mx.n) L.push('## Mixed crowd (secondary, round 1 of "isolated", no extra calls)', '',
    `Crowd error over ${mx.n} questions: 32 × ${slug(mx.a)} ${fmt(mx.err_a)}; 32 × ${slug(mx.b)} ${fmt(mx.err_b)}; 16 + 16 mixed ${fmt(mx.err_mix)}.`, '');
  return L.join('\n');
}

function untilTime(hhmm, now = new Date()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  const t = new Date(now); t.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t.getTime();
}

async function main(file, opts = {}) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = { run: 'c1', agents: 32, questions: 16, rounds: 3, seed: 22, families: [], ...raw, force: !!opts.force };
  const all = loadConfig().agents;
  const base = path.join(HOME_DIR, 'crowd', cfg.run);
  fs.mkdirSync(base, { recursive: true });
  const cells = [], gates = {};
  const stopAt = untilTime(opts.until);
  let stopped = false;
  const write = () => fs.writeFileSync(path.join(base, 'summary.md'), summary(cfg, cells, gates));
  const fams = cfg.families.filter(f => !opts.family || opts.family.includes(f));
  for (const f of fams) {
    const done = {};
    const cell = async (arm, q) => {
      if (done[`${arm}/${q}`] !== undefined) return done[`${arm}/${q}`];
      const kept = path.join(base, 'cells', slug(f), arm, `q${q}.json`);
      if (!fs.existsSync(kept) && stopAt && Date.now() > stopAt) { console.log(`- ${slug(f)} ${arm} q${q}: stopped at --until, runs next time`); stopped = true; return null; }
      const c = await runCell(cfg, all, f, arm, q, arm === 'isolated' ? null : done[`isolated/${q}`]);
      done[`${arm}/${q}`] = c;
      if (c) cells.push(c);
      write();
      return c;
    };
    for (let q = 1; q <= Math.min(2, cfg.questions); q++) await cell('isolated', q);
    if (stopped) break;
    gates[f] = gate(cells.filter(c => c.family === f));
    write();
    if (!gates[f].pass) { console.warn(`! ${slug(f)}: gate failed (${gates[f].why.join('; ')}); this family stops`); continue; }
    for (let q = 1; q <= cfg.questions && !stopped; q++) for (const arm of [...ARMS, 'calib']) { await cell(arm, q); if (stopped) break; }
    if (stopped) break;
  }
  write();
  console.log(`Summary: ${path.join(base, 'summary.md')}`);
  return { cells, gates };
}

module.exports = { weight, predicted, prediction, inWords, makeQuestion, network, prompt, parseReply, measures, hypotheses, gate, boot, spearman, main };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const file = argv.find(a => a.endsWith('.json'));
  if (!file) { console.error('usage: node crowd.js <crowd.json> [--family local:qwen3:8b,...] [--until HH:MM] [--force]'); process.exit(2); }
  main(file, { family: opt('--family')?.split(','), until: opt('--until'), force: argv.includes('--force') }).catch(e => {
    if (e instanceof NotAnswering) { console.error(`✗ stopping: the model is not answering (${e.message}). Is Ollama running and the Mac awake? Run the same command again to carry on.`); process.exit(3); }
    console.error(e.message); process.exit(1);
  });
}
