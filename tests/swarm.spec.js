// @ts-check
// swarm.js: a stand-in for Ollama answers every agent ("local:<model>"), with
// a simple greedy player, so the whole study runs without a model.
const { test, expect } = require('@playwright/test');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { makeMap, makeNest, makeGather, conflicts, mapScore, nestScore, gatherScore, parseMap, parseGather } = require('../swarm');

const COLOURS = ['red', 'green', 'blue', 'yellow'];

function play(prompt) {
  if (/hand in one list/.test(prompt)) {
    const mine = prompt.match(/Your private number is (\d+)/)[1];
    const board = (prompt.match(/^Board: (.*)$/m) || [])[1];
    const xs = board && !/empty/.test(board) ? board.split(', ') : [];
    return [`POST ${mine}`, xs.length ? `SUBMIT ${[...new Set([...xs, mine].map(Number))].sort((a, b) => a - b).join(', ')}` : null].filter(Boolean).join('\n');
  }
  if (/You lead \d+ workers/.test(prompt) && /new home/.test(prompt)) {
    const reports = [...prompt.matchAll(/on site (\d+): quality (-?\d+)/g)];
    if (reports.length >= 3) return `DECIDE ${reports.sort((a, b) => Number(b[2]) - Number(a[2]))[0][1]}`;
    return [1, 2, 3].map(w => `W${w} ${w * 3 + reports.length}`).join('\n');
  }
  if (/You lead \d+ workers/.test(prompt)) {
    const areas = [...prompt.matchAll(/^area (\d+): .*conflicts (\d+)/gm)].sort((a, b) => Number(b[2]) - Number(a[2]));
    return [1, 2, 3].map((w, k) => `W${w} ${areas[k % areas.length][1]} fix the conflicts in this area please`).join('\n');
  }
  if (/sent you to inspect/.test(prompt)) {
    const [, s, d, h, x] = prompt.match(/size (\d+), dryness (\d+), height (\d+), distance (\d+)/).map(Number);
    return `REPORT ${s + 2 * d + h - x} looks fine`;
  }
  if (/new home/.test(prompt)) {
    const seen = [...prompt.matchAll(/^site (\d+): size (\d+), dryness (\d+), height (\d+), distance (\d+)/gm)].map(m => ({ i: Number(m[1]), q: Number(m[2]) + 2 * Number(m[3]) + Number(m[4]) - Number(m[5]) }));
    const best = seen.sort((a, b) => b.q - a.q)[0];
    const danced = prompt.match(/^site (\d+): strength/m);
    const out = [];
    if (/INSPECT </.test(prompt)) out.push(`INSPECT ${((best?.i || 1) * 7) % 20 + 1}`);
    if (/FINAL </.test(prompt) && !/INSPECT </.test(prompt)) return `FINAL ${best.i}`;
    if (best && /DANCE </.test(prompt)) out.push(`DANCE ${best.i} ${best.q}`);
    const pick = best ? best.i : danced ? Number(danced[1]) : null;
    if (pick && !/FINAL </.test(prompt)) out.push(`VOTE ${pick}`);
    if (/SAY </.test(prompt) && best) out.push(`SAY site ${best.i} has quality ${best.q}`);
    return out.join('\n') || 'nothing';
  }
  // Map: fix the first conflicting region in view with a colour none of its neighbours has.
  const lines = [...prompt.matchAll(/^region (\d+) \((\w+)\): touches (.*)$/gm)];
  const out = [];
  for (const l of lines) {
    if (!/CONFLICT/.test(l[3]) || out.length) continue;
    const used = new Set([...l[3].matchAll(/\((\w+)\)/g)].map(m => m[1]));
    const free = COLOURS.find(c => !used.has(c));
    if (free) out.push(`SET ${l[1]} ${free}`);
  }
  if (!out.length && /DONE/.test(prompt) && !/CONFLICT/.test(prompt)) return 'DONE';
  const area = prompt.match(/You are in area (\d+)/);
  if (area && /MARK </.test(prompt)) out.push(`MARK ${area[1]} 2 still some conflicts here, come help`);
  if (area && /SAY </.test(prompt)) out.push(`SAY area ${area[1]} still has conflicts`);
  if (area) out.push(`GO ${area[1]}`);
  if (/REPORT </.test(prompt)) out.push('REPORT fixed one region');
  return out.join('\n') || 'nothing to do';
}

test('map and nest generators: solvable map, one best site, scores 0-100', () => {
  for (const seed of [1, 2, 3]) {
    const m = makeMap(seed);
    expect(conflicts(m, m.hidden)).toBe(0);
    expect(conflicts(m, m.start)).toBeGreaterThan(0);
    expect(mapScore(m, m.hidden)).toBe(100);
    expect(mapScore(m, m.start)).toBe(0);
    expect(m.areas.length).toBe(12);
    const n = makeNest(seed);
    expect(n.sites.filter(s => s.q === n.best).length).toBe(1);
    expect(nestScore(n, n.bestSite)).toBe(100);
    expect(nestScore(n, null)).toBe(0);
  }
  expect(parseMap('**SET 3 blue**\nMARK area 2 3 help here\nGO 4').set).toEqual([{ i: 2, c: 2 }]);
  const g = makeGather(1, 12);
  expect(new Set(g).size).toBe(12);
  expect(gatherScore(g, [...g].sort((a, b) => a - b))).toBe(100);
  expect(gatherScore(g, null)).toBe(0);
  expect(parseGather('POST 42\nSUBMIT: 1, 2, 42')).toEqual({ post: 42, submit: [1, 2, 42] });
});

test('a whole swarm study runs on local stand-in models and writes bench cells', async () => {
  const prompts = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: ['fake-a', 'fake-b', 'fake-strong'].map(name => ({ name })) }));
      const j = JSON.parse(body);
      const p = j.messages[0].content;
      prompts.push({ model: j.model, prompt: p, auth: req.headers.authorization, url: req.url, think: j.think, ctx: j.options?.num_ctx });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ model: j.model, choices: [{ message: { content: `<think>hmm</think>\n${play(p)}` } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', () => r(null)));
  try {
    const port = /** @type {any} */ (server.address()).port;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-home-'));
    fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [] }));
    const file = path.join(home, 's.json');
    fs.writeFileSync(file, JSON.stringify({ run: 'bench-t', small: ['local:fake-a', 'local:fake-b'], strong: 'local:fake-strong',
      budget: 8, swarm: 4, repeats: 2, seed: 3, map: { regions: 40, area: 5 }, nest: { sites: 20, inspect: 2 } }));
    const env = { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0',
      OLLAMA_BASE: `http://127.0.0.1:${port}`, OPENROUTER_API_KEY: '' };
    const node = (...a) => promisify(execFile)('node', [path.join(__dirname, '..', 'swarm.js'), ...a], { env, encoding: 'utf8', maxBuffer: 1 << 24 });
    await node(file);
    const cells = path.join(home, 'bench', 'bench-t', 'cells');
    const read = (t, a, r) => JSON.parse(fs.readFileSync(path.join(cells, t, a, `r${r}.json`), 'utf8'));
    expect(fs.readdirSync(path.join(cells, 'map')).sort()).toEqual(['best-of-4-isolated', 'boss-workers', 'solo-small', 'solo-strong', 'swarm-marks', 'swarm-no-marks']);
    expect(fs.readdirSync(path.join(cells, 'nest')).sort()).toEqual(['boss-workers', 'solo-small', 'solo-strong', 'swarm-imitation-only', 'swarm-marks', 'swarm-no-marks']);
    for (const t of ['map', 'nest']) for (const a of fs.readdirSync(path.join(cells, t))) for (const r of [1, 2]) {
      const c = read(t, a, r);
      expect(c).toMatchObject({ task: t, config: a, repeat: r });
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(100);
      expect(c.calls).toBeGreaterThan(0);
      expect(c.calls).toBeLessThanOrEqual(8);
      expect(Array.isArray(c.observations.quotes)).toBe(true);
      expect(c.observations.failures).toBe(0);
    }
    // One family per repeat; the strong model only in solo-strong.
    expect(read('map', 'swarm-marks', 1).models).toEqual(['fake-a']);
    expect(read('map', 'swarm-marks', 2).models).toEqual(['fake-b']);
    expect(read('map', 'solo-strong', 1).models).toEqual(['fake-strong']);
    expect(read('map', 'swarm-marks', 1).cost_gbp).toBe(0);
    // The greedy player fixes conflicts; marks are left and the swarm keeps its starter.
    expect(read('map', 'solo-small', 1).score).toBeGreaterThan(0);
    const sw = read('map', 'swarm-marks', 1);
    expect(sw.observations.marks_left).toBeGreaterThan(0);
    expect(sw.starter).toMatch(/^local-fake-a-\d$/);
    expect(read('map', 'swarm-no-marks', 1).observations.marks_left).toBe(0);
    expect(read('map', 'boss-workers', 1).observations.instructions).toBeGreaterThan(0);
    expect(read('nest', 'swarm-marks', 1).observations.dances).toBeGreaterThan(0);
    expect(read('nest', 'solo-strong', 1).score).toBeGreaterThan(0);
    // Prompts: no marks in the control, no inspecting for imitators, no thinking block passed on.
    const noMarks = prompts.filter(p => /You are in area/.test(p.prompt) && !/MARK </.test(p.prompt));
    expect(noMarks.length).toBeGreaterThan(0);
    expect(noMarks.every(p => !/Marks on your area/.test(p.prompt))).toBe(true);
    expect(prompts.some(p => /You cannot inspect sites/.test(p.prompt))).toBe(true);
    expect(prompts.every(p => p.auth === undefined)).toBe(true);
    expect(prompts.every(p => p.url === '/api/chat' && p.think === false && p.ctx === 8192)).toBe(true);
    // Agents work in an empty folder; usage goes to the local log.
    const dir = read('map', 'swarm-marks', 1).source;
    expect(fs.readdirSync(path.join(dir, 'cwd'))).toEqual([]);
    expect(fs.readFileSync(path.join(home, 'local-usage.jsonl'), 'utf8').trim().split('\n').length).toBe(prompts.length);
    // A second run keeps every cell.
    const before = prompts.length;
    const { stdout } = await node(file);
    expect(prompts.length).toBe(before);
    expect(stdout).toContain('kept');
  } finally { server.close(); }
});

test('symmetry arms: everyone starts in one place, specialisation per agent, a knockout halfway', async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: ['fake-a', 'fake-b', 'fake-strong'].map(name => ({ name })) }));
      const p = JSON.parse(body).messages[0].content;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: play(p) } }] }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', () => r(null)));
  try {
    const port = /** @type {any} */ (server.address()).port;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-sym-'));
    fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [] }));
    const file = path.join(home, 's.json');
    fs.writeFileSync(file, JSON.stringify({ run: 'sym', small: ['local:fake-a'], strong: 'local:fake-a', symmetry: true,
      budget: 16, swarm: 4, repeats: 1, seed: 5, map: { regions: 40, area: 5 }, nest: { sites: 20, inspect: 2 } }));
    const env = { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0', OLLAMA_BASE: `http://127.0.0.1:${port}` };
    await promisify(execFile)('node', [path.join(__dirname, '..', 'swarm.js'), file, '--arms', 'swarm-marks,swarm-marks-same,swarm-no-marks-same,swarm-marks-same-knockout'], { env, encoding: 'utf8', maxBuffer: 1 << 24 });
    const read = (t, a) => JSON.parse(fs.readFileSync(path.join(home, 'bench', 'sym', 'cells', t, a, 'r1.json'), 'utf8'));
    const same = read('map', 'swarm-marks-same').observations;
    const firsts = Object.values(same.areas_by_agent).map(v => v[0]);
    expect(new Set(firsts).size).toBe(1);
    expect(same.spread_by_round[0]).toBe(1);
    expect(Object.keys(same.specialisation_by_agent).length).toBe(4);
    const spread = read('map', 'swarm-marks').observations;
    expect(new Set(Object.values(spread.areas_by_agent).map(v => v[0])).size).toBe(4);
    const ko = read('map', 'swarm-marks-same-knockout');
    expect(ko.observations.knockout.round).toBe(3);
    expect(ko.calls).toBe(4 * 2 + 3 * 2);
    expect(ko.observations.spread_before_knockout).not.toBeNull();
    const nest = read('nest', 'swarm-marks-same').observations;
    expect(Object.values(nest.areas_by_agent).every(v => v.length <= 2)).toBe(true);
    expect(read('nest', 'swarm-no-marks-same').score).toBeGreaterThanOrEqual(0);
  } finally { server.close(); }
});

test('gather task and the "self" incentive arm', async () => {
  const prompts = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: ['fake-a', 'fake-b', 'fake-strong'].map(name => ({ name })) }));
      const p = JSON.parse(body).messages[0].content;
      prompts.push(p);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: play(p) } }] }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', () => r(null)));
  try {
    const port = /** @type {any} */ (server.address()).port;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-gather-'));
    fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [] }));
    const file = path.join(home, 's.json');
    fs.writeFileSync(file, JSON.stringify({ run: 'g', small: ['local:fake-a'], strong: 'local:fake-a', tasks: ['gather', 'map'], incentive: true,
      budget: 12, swarm: 4, scale: [6], repeats: 1, seed: 2, map: { regions: 40, area: 5 } }));
    const env = { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0', OLLAMA_BASE: `http://127.0.0.1:${port}` };
    await promisify(execFile)('node', [path.join(__dirname, '..', 'swarm.js'), file, '--arms', 'swarm-marks,swarm-no-marks,swarm-marks-6,swarm-marks-self'], { env, encoding: 'utf8', maxBuffer: 1 << 24 });
    const read = (t, a) => JSON.parse(fs.readFileSync(path.join(home, 'bench', 'g', 'cells', t, a, 'r1.json'), 'utf8'));
    expect(read('gather', 'swarm-marks').score).toBe(100);
    expect(read('gather', 'swarm-marks-6').observations.right.length).toBe(6);
    expect(read('gather', 'swarm-no-marks').score).toBeLessThan(100);
    expect(read('map', 'swarm-marks-self').calls).toBe(12);
    expect(prompts.some(p => /You are scored only on the conflicts you fix yourself/.test(p))).toBe(true);
    expect(prompts.some(p => /The whole team is scored together, on the conflicts left/.test(p))).toBe(true);
    expect(prompts.filter(p => /hand in one list/.test(p) && /Board:/.test(p)).length).toBeGreaterThan(0);
  } finally { server.close(); }
});

test('chat arms post messages everyone sees; scouts back only sites they inspected', async () => {
  const prompts = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: ['fake-a', 'fake-b', 'fake-strong'].map(name => ({ name })) }));
      const p = JSON.parse(body).messages[0].content;
      prompts.push(p);
      // A scout that always votes for site 1, seen or not.
      const text = /new home/.test(p) && !/sent you/.test(p) && !/You lead/.test(p) ? `VOTE 1\n${play(p)}` : play(p);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', () => r(null)));
  try {
    const port = /** @type {any} */ (server.address()).port;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-chat-'));
    fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [] }));
    const file = path.join(home, 's.json');
    fs.writeFileSync(file, JSON.stringify({ run: 'c', small: ['local:fake-a'], strong: 'local:fake-a', chat: true, scale: [6],
      budget: 12, swarm: 4, repeats: 1, seed: 4, map: { regions: 40, area: 5 }, nest: { sites: 20, inspect: 2 } }));
    const env = { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0', OLLAMA_BASE: `http://127.0.0.1:${port}` };
    await promisify(execFile)('node', [path.join(__dirname, '..', 'swarm.js'), file, '--arms', 'swarm-chat,swarm-chat-6,swarm-marks'], { env, encoding: 'utf8', maxBuffer: 1 << 24 });
    const read = (t, a) => JSON.parse(fs.readFileSync(path.join(home, 'bench', 'c', 'cells', t, a, 'r1.json'), 'utf8'));
    expect(read('map', 'swarm-chat').observations.messages).toBeGreaterThan(0);
    expect(read('map', 'swarm-chat-6').observations.messages).toBeGreaterThan(0);
    expect(prompts.some(p => /Messages \(newest last\):\nagent \d/.test(p))).toBe(true);
    expect(read('nest', 'swarm-chat').observations.messages).toBeGreaterThan(0);
    const marks = read('nest', 'swarm-marks').observations;
    expect(marks.unseen_ignored).toBeGreaterThan(0);
    expect(prompts.some(p => /vote only for sites you have inspected yourself/.test(p))).toBe(true);
  } finally { server.close(); }
});

test('a local model Ollama lacks: its repeats are skipped; a model that stops answering stops the run; failed cells run again', async () => {
  let fail = true;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'fake-a' }] }));
      if (fail) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'boom' })); }
      res.end(JSON.stringify({ choices: [{ message: { content: play(JSON.parse(body).messages[0].content) } }] }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', () => r(null)));
  try {
    const port = /** @type {any} */ (server.address()).port;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-miss-'));
    fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [] }));
    const file = path.join(home, 's.json');
    fs.writeFileSync(file, JSON.stringify({ run: 'm', small: ['local:fake-a', 'local:not-pulled'], strong: 'local:fake-a',
      budget: 8, swarm: 4, repeats: 2, seed: 4, tasks: ['map'], map: { regions: 40, area: 5 } }));
    const env = { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0', OLLAMA_BASE: `http://127.0.0.1:${port}` };
    const node = () => promisify(execFile)('node', [path.join(__dirname, '..', 'swarm.js'), file, '--arms', 'swarm-marks'], { env, encoding: 'utf8', maxBuffer: 1 << 24 });
    // Every call fails: the run stops after 4 in a row, with exit 3, and keeps no cell.
    const err = await node().then(() => null, e => e);
    expect(err?.code).toBe(3);
    expect(err.stderr).toContain('local:not-pulled is not in Ollama');
    expect(err.stderr).toContain('the model is not answering');
    expect((err.stderr.match(/^  ✗ /gm) || []).length).toBeLessThanOrEqual(8);
    const cell = r => path.join(home, 'bench', 'm', 'cells', 'map', 'swarm-marks', `r${r}.json`);
    expect(fs.existsSync(cell(1))).toBe(false);
    fail = false;
    await node();
    expect(fs.existsSync(cell(1))).toBe(true);
    expect(fs.existsSync(cell(2))).toBe(false);
    const kept = JSON.parse(fs.readFileSync(cell(1), 'utf8'));
    expect(kept.observations.failures).toBe(0);
    expect(kept.observations.call_seconds.median).toBeGreaterThanOrEqual(0);
    // A cell saved by the old rule with too many failed calls runs again; a clean one is kept.
    fs.writeFileSync(cell(1), JSON.stringify({ ...kept, score: 14.3, calls: 60, observations: { ...kept.observations, failures: 7 } }));
    const again = await node();
    expect(again.stdout).toContain('7 of 60 calls had failed, running it again');
    expect(JSON.parse(fs.readFileSync(cell(1), 'utf8')).observations.failures).toBe(0);
    expect(fs.readdirSync(path.dirname(cell(1))).some(f => /^r1\.json\.failed-\d+$/.test(f))).toBe(true);
    expect((await node()).stdout).toContain('map/swarm-marks/r1: kept');
  } finally { server.close(); }
});

