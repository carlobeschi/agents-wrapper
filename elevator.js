#!/usr/bin/env node
// @ts-check
// The elevator task of study 16 (diamond.js): a building, a day of people and
// a controller someone wrote. `node elevator.js <controller.js> <days.json>`
// prints one line, `RESULT {...}`, with the result of every day.
//
// The building: FLOORS floors (0 is the lobby), CARS cars of CAPACITY people.
// One tick = one second. A car takes FLOOR_TICKS ticks per floor; a stop (doors
// open, people out, people in, doors closed) takes STOP ticks plus PER_PERSON
// tick for each person who gets out or in. People arrive for
// ARRIVALS ticks; the day then runs until everyone is delivered or for GRACE
// more ticks. Someone still not delivered at the end counts as (end - arrival
// + PENALTY) ticks.
//
// A day is a seed plus a kind, so it is the same every time:
//   up      morning: most people go from the lobby to a floor
//   down    evening: most people go from a floor to the lobby
//   lunch   to and from the lobby and the canteen (floor 10), plus some random
//   inter   between random floors
// and an intensity (people per tick, 0.12 by default; 0.18 is a busy day).
// "ticks" shortens the hour of arrivals (the tests use it).
//
// The controller is plain JavaScript run in a fresh context (node:vm) with no
// require, process or timers: `module.exports = { step }`. Every tick the
// simulator calls step(view) and the controller answers with one command per
// car, `{ go: <floor>, dir: 'up' | 'down' | null }` or null (keep the last
// command). See BRIEF below. A car stops when it reaches its `go` floor; it also
// serves people when it stands at its `go` floor and someone can get in or out.
// Only people going in the car's `dir` get in (everyone if dir is null).
// A step that throws or takes longer than STEP_MS is an error: the cars keep
// their last commands. A day that runs past DAY_MS of controller time stops
// there and everyone left counts as not delivered.

const fs = require('fs');
const vm = require('vm');

const FLOORS = 20, CARS = 4, CAPACITY = 10, FLOOR_TICKS = 2, STOP = 6, PER_PERSON = 1;
const ARRIVALS = 3600, GRACE = 1800, PENALTY = 600;
const STEP_MS = 50, DAY_MS = 60000;
const CANTEEN = 10;

// What the agents are told: the building, the controller's view and the score.
const BRIEF = `The building has ${FLOORS} floors (0 is the lobby) and ${CARS} elevator cars of ${CAPACITY} people each. One tick is one second.
A car takes ${FLOOR_TICKS} ticks per floor. A stop takes ${STOP} ticks plus ${PER_PERSON} tick for each person who gets out or in.
People arrive for an hour (${ARRIVALS} ticks); the day then runs until everyone is delivered or for ${GRACE} more ticks.
Kinds of day: "up" (morning: most go from the lobby to a floor), "down" (evening: most go from a floor to the lobby),
"lunch" (to and from the lobby and the canteen on floor ${CANTEEN}, plus some random trips), "inter" (between random floors).
Some days are busier than others.

You write controller.js, plain JavaScript (no require, no timers, no process):
  module.exports = { step(view) { ... return commands; } };
step(view) is called every tick with a fresh copy of:
  { time, floors, capacity,
    cars:  [{ floor, go, dir, load, stops: [floors the people inside want, sorted], doors: ticks left at the current stop (0 = not stopped) }],
    calls: [{ floor, dir: 'up' | 'down', since: tick when the first person still waiting pressed it }] }
It returns an array with one entry per car: { go: <floor>, dir: 'up' | 'down' | null }, or null to keep that car's last command.
A car drives to its "go" floor and stops there. While it stands at its "go" floor it serves anyone who can get out or in:
people whose floor it is get out; waiting people get in if there is room and they go in the car's "dir" (everyone if dir is null).
A car does not stop at floors on the way unless you make one its "go". You see the buttons, not the people:
not how many wait at a floor, nor where they go until they are inside. Keep any state you need in variables of your own module.
A step that throws or takes more than ${STEP_MS} ms is an error (the cars keep their last commands).

Score: the average journey time (arrival to getting out) over a day, compared with a baseline controller
("send the nearest car": cars carry their passengers to the nearest stop ahead and pick up calls in their direction on the way;
an idle car takes the oldest call no other car is going to). Gain = how much shorter your average journey is, in %, averaged over the days.
Anyone not delivered by the end counts as their time so far plus ${PENALTY} ticks. Your controller is also scored on days you never see.`;

// mulberry32: a small seeded random generator, the same on every machine.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {{kind: string, seed: number, intensity?: number, ticks?: number}} day */
function makeDay(day) {
  const r = rng(day.seed);
  const rate = day.intensity ?? 0.12;
  const floor = () => 1 + Math.floor(r() * (FLOORS - 1));
  const any = () => Math.floor(r() * FLOORS);
  const pair = () => { const a = any(); let b = any(); while (b === a) b = any(); return [a, b]; };
  const people = [];
  for (let t = 0; t < (day.ticks ?? ARRIVALS); t++) {
    // Poisson arrivals: at most a few per tick.
    let k = 0, p = Math.exp(-rate), s = p;
    const u = r();
    while (u > s && k < 10) { k++; p *= rate / k; s += p; }
    for (let i = 0; i < k; i++) {
      const x = r();
      let from, to;
      if (day.kind === 'up') [from, to] = x < 0.85 ? [0, floor()] : x < 0.95 ? pair() : [floor(), 0];
      else if (day.kind === 'down') [from, to] = x < 0.85 ? [floor(), 0] : x < 0.95 ? pair() : [0, floor()];
      else if (day.kind === 'lunch') {
        if (x < 0.2) [from, to] = [0, floor()];
        else if (x < 0.4) [from, to] = [floor(), 0];
        else if (x < 0.55) [from, to] = [any(), CANTEEN];
        else if (x < 0.7) [from, to] = [CANTEEN, any()];
        else [from, to] = pair();
        if (from === to) [from, to] = pair();
      } else if (day.kind === 'inter') [from, to] = pair();
      else throw new Error(`unknown kind of day "${day.kind}"`);
      people.push({ id: people.length, t, from, to });
    }
  }
  return people;
}

function loadController(source) {
  const module = { exports: /** @type {any} */ ({}) };
  const ctx = vm.createContext({ module, exports: module.exports, Math, JSON, console: { log() {}, warn() {}, error() {} } });
  vm.runInContext(String(source), ctx, { timeout: 1000, filename: 'controller.js' });
  const step = module.exports && (module.exports.step || (typeof module.exports === 'function' ? module.exports : null));
  if (typeof step !== 'function') throw new Error('controller.js does not export step(view)');
  ctx.__step = step;
  return ctx;
}

/** Runs one day. Returns the numbers that count. */
function simulate(source, day, trace = null) {
  const people = makeDay(day);
  const result = { name: day.name || `${day.kind}-${day.seed}`, kind: day.kind, people: people.length, delivered: 0, journey: 0, wait: 0, max_wait: 0, errors: 0, first_error: null, stopped: null };
  let ctx;
  try { ctx = loadController(source); }
  catch (e) { result.stopped = `controller did not load: ${String(e && e.message || e).slice(0, 200)}`; }
  const waiting = Array.from({ length: FLOORS }, () => []);
  const cars = Array.from({ length: CARS }, () => ({ floor: 0, go: null, dir: null, doors: 0, travel: 0, inside: [] }));
  let next = 0, t = 0, spent = 0, done = 0, boardedN = 0, waitSum = 0, journeySum = 0, maxWait = 0;
  const end = (day.ticks ?? ARRIVALS) + GRACE;
  const deliver = (p, now) => { done++; journeySum += now - p.t; };
  for (; t < end; t++) {
    while (next < people.length && people[next].t === t) { const p = people[next++]; waiting[p.from].push(p); }
    if (next >= people.length && done === people.length) break;
    if (ctx && !result.stopped) {
      const calls = [];
      for (let f = 0; f < FLOORS; f++) {
        for (const dir of ['up', 'down']) {
          const w = waiting[f].filter(p => (p.to > f) === (dir === 'up'));
          if (w.length) calls.push({ floor: f, dir, since: w[0].t });
        }
      }
      ctx.__view = JSON.parse(JSON.stringify({
        time: t, floors: FLOORS, capacity: CAPACITY, calls,
        cars: cars.map(c => ({ floor: c.floor, go: c.go, dir: c.dir, load: c.inside.length, stops: [...new Set(c.inside.map(p => p.to))].sort((a, b) => a - b), doors: c.doors })),
      }));
      const t0 = Date.now();
      let out = null;
      try { out = vm.runInContext('__step(__view)', ctx, { timeout: STEP_MS }); }
      catch (e) { result.errors++; if (!result.first_error) result.first_error = `tick ${t}: ${String(e && e.message || e).slice(0, 200)}`; }
      spent += Date.now() - t0;
      if (trace) trace(ctx.__view, out, cars, waiting);
      if (spent > DAY_MS) result.stopped = `controller used more than ${DAY_MS / 1000} s on this day (tick ${t})`;
      if (Array.isArray(out)) {
        out.slice(0, CARS).forEach((cmd, i) => {
          if (!cmd || typeof cmd !== 'object') return;
          const go = Number(cmd.go);
          if (!Number.isInteger(go) || go < 0 || go >= FLOORS) return;
          cars[i].go = go;
          cars[i].dir = cmd.dir === 'up' || cmd.dir === 'down' ? cmd.dir : null;
        });
      }
    }
    for (const c of cars) {
      if (c.doors > 0) { c.doors--; continue; }
      if (c.go === null) continue;
      if (c.go !== c.floor) {
        // A floor takes FLOOR_TICKS ticks; the car counts as at the floor it left until it gets to the next.
        if (++c.travel < FLOOR_TICKS) continue;
        c.travel = 0;
        c.floor += c.go > c.floor ? 1 : -1;
        if (c.go !== c.floor) continue;
      } else c.travel = 0;
      // At its go floor (just arrived, or standing there): serve whoever can get out or in.
      const out = c.inside.filter(p => p.to === c.floor);
      const room = CAPACITY - (c.inside.length - out.length);
      const may = waiting[c.floor].filter(p => !c.dir || (p.to > c.floor) === (c.dir === 'up'));
      if (!out.length && !(may.length && room > 0)) continue;
      for (const p of out) deliver(p, t);
      c.inside = c.inside.filter(p => p.to !== c.floor);
      for (const p of may.slice(0, room)) {
        const w = t - p.t;
        waitSum += w; boardedN++; if (w > maxWait) maxWait = w;
        c.inside.push(p);
      }
      const boarded = new Set(may.slice(0, room));
      waiting[c.floor] = waiting[c.floor].filter(p => !boarded.has(p));
      c.doors = STOP + PER_PERSON * (out.length + boarded.size);
    }
  }
  const left = people.length - done;
  // Everyone not delivered (waiting, inside a car or not arrived because the
  // controller stopped) counts as (end - arrival + PENALTY).
  const notDelivered = [...waiting.flat(), ...cars.flatMap(c => c.inside), ...people.slice(next)];
  for (const p of notDelivered) journeySum += Math.max(0, t - p.t) + PENALTY;
  result.delivered = done;
  result.journey = people.length ? +(journeySum / people.length).toFixed(2) : 0;
  result.wait = boardedN ? +(waitSum / boardedN).toFixed(2) : 0;
  result.max_wait = maxWait;
  result.not_delivered = left;
  return result;
}

// The baseline: "send the nearest car". A car with people inside goes to the
// nearest of their floors ahead of it, picking up calls in its direction on the
// way; an empty car that is not already on its way somewhere takes the
// oldest call nobody else is going to.
const BASELINE = `
module.exports = { step(v) {
  const taken = new Set();
  const out = v.cars.map(() => null);
  v.cars.forEach((c, i) => {
    if (!c.stops.length) return;
    const up = c.dir ? c.dir === 'up' : c.stops[0] > c.floor;
    const ahead = c.stops.filter(f => up ? f >= c.floor : f <= c.floor);
    const pool = ahead.length ? ahead : c.stops;
    let go = pool.reduce((a, f) => Math.abs(f - c.floor) < Math.abs(a - c.floor) ? f : a, pool[0]);
    const dirNow = go > c.floor ? 'up' : go < c.floor ? 'down' : (up ? 'up' : 'down');
    for (const k of v.calls) if (k.dir === dirNow && c.load < v.capacity && (dirNow === 'up' ? k.floor > c.floor && k.floor < go : k.floor < c.floor && k.floor > go)) { go = k.floor; taken.add(k.floor + k.dir); }
    out[i] = { go, dir: dirNow };
  });
  for (const k of v.calls.slice().sort((a, b) => a.since - b.since)) {
    if (taken.has(k.floor + k.dir)) continue;
    if (v.cars.some(c => c.go === k.floor && c.dir === k.dir)) continue;
    let best = -1;
    v.cars.forEach((c, i) => { if (!c.stops.length && out[i] === null && (c.go === null || c.go === c.floor) && (best < 0 || Math.abs(c.floor - k.floor) < Math.abs(v.cars[best].floor - k.floor))) best = i; });
    if (best >= 0) { out[best] = { go: k.floor, dir: k.dir }; taken.add(k.floor + k.dir); }
  }
  return out;
} };
`;

/** Runs every day; adds the baseline's journey and the gain over it, in %. */
const baseCache = new Map();
function evaluate(source, days) {
  const rows = days.map(d => {
    const key = JSON.stringify(d);
    if (!baseCache.has(key)) baseCache.set(key, simulate(BASELINE, d));
    const mine = simulate(source, d), base = baseCache.get(key);
    return { ...mine, baseline: base.journey, gain: base.journey ? +((base.journey - mine.journey) / base.journey * 100).toFixed(2) : 0 };
  });
  const gain = rows.length ? +(rows.reduce((s, r) => s + r.gain, 0) / rows.length).toFixed(2) : 0;
  return { gain, days: rows };
}

module.exports = { FLOORS, CARS, CAPACITY, FLOOR_TICKS, STOP, PER_PERSON, ARRIVALS, GRACE, PENALTY, CANTEEN, BRIEF, rng, makeDay, simulate, evaluate, BASELINE };

if (require.main === module) {
  const [ctl, daysFile] = process.argv.slice(2);
  if (!ctl || !daysFile) { console.error('usage: node elevator.js <controller.js> <days.json>'); process.exit(2); }
  const days = JSON.parse(fs.readFileSync(daysFile, 'utf8'));
  console.log('RESULT ' + JSON.stringify(evaluate(fs.readFileSync(ctl, 'utf8'), days)));
}
