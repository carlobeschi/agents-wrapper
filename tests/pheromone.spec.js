// @ts-check
// pheromone.js: a stand-in for Ollama answers every agent ("local:<model>"),
// so the whole study runs without a model. No model is called.
const { test, expect } = require('@playwright/test');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { parseReply, decayOnlyRounds, lifetime, gate } = require('../pheromone');

const COLOURS = ['red', 'green', 'blue', 'yellow'];

// A greedy copy: fixes one conflict, leaves +2 on a busy area and -2 on a calm
// one, and goes to the neighbour with the highest number. "blind" ignores marks.
function play(prompt, blind) {
  const out = [];
  for (const l of prompt.matchAll(/^region (\d+) \((\w+)\): touches (.*)$/gm)) {
    if (!/CONFLICT/.test(l[3]) || out.length) continue;
    const used = new Set([...l[3].matchAll(/\((\w+)\)/g)].map(m => m[1]));
    const free = COLOURS.find(c => !used.has(c));
    if (free) out.push(`SET ${l[1]} ${free}`);
  }
  const here = Number(prompt.match(/You are in area (\d+)/)[1]);
  const busy = Number(prompt.match(/Conflicts touching your area: (\d+)/)[1]) > 0;
  if (/MARK </.test(prompt)) out.push(`MARK ${here} ${busy ? '+2' : '-2'}`);
  const next = (prompt.match(/^Areas next to yours: (.*)$/m)[1].match(/\d+(?: \(number [^)]*\))?/g) || [])
    .map(s => ({ z: Number(s.match(/^\d+/)[0]), v: Number((s.match(/number ([+-]?[\d.]+)/) || [0, 0])[1]) }));
  const best = [...next].sort((a, b) => b.v - a.v)[0];
  out.push(`GO ${blind || !best || best.v <= 0 ? (busy || !next.length ? here : next[0].z) : best.z}`);
  return out.join('\n');
}

async function withFakeOllama(blind, fn) {
  const prompts = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'fake-a' }, { name: 'fake-b' }] }));
      const j = JSON.parse(body);
      const p = j.messages[0].content;
      prompts.push(p);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ model: j.model, choices: [{ message: { content: play(p, blind.includes(j.model)) } }], message: { content: play(p, blind.includes(j.model)) } }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', () => r(null)));
  try { return await fn(/** @type {any} */ (server.address()).port, prompts); } finally { server.close(); }
}

test('replies, the decay-only line and the main measure', () => {
  expect(parseReply('SET 3 blue\nMARK area 2 -3\nGO 4')).toMatchObject({ set: [{ i: 2, c: 2 }], mark: { z: 1, s: -3 }, go: 3, readable: true });
  expect(parseReply('MARK 5 +2 all fine here').mark).toEqual({ z: 4, s: 2, text: 'all fine here' });
  expect(parseReply('I think the map is nice').readable).toBe(false);
  // A -3 left at round 2 is seen at the start of rounds 3-6, then it is gone.
  expect(decayOnlyRounds(10)).toEqual([2, 3, 4, 5]);
  const row = (net, conflicts) => [{ net, conflicts }];
  const faded = [row(0, 2), row(0, 2), row(-1.8, 2), row(-1.1, 2), row(-0.6, 2), row(-0.4, 2), row(0, 2)];
  expect(lifetime(faded, [0], 6)[0]).toMatchObject({ wrong_rounds: 4, after_fade: 0, amplified: false });
  const kept = [...faded.slice(0, 6), row(-1.2, 1), row(-0.9, 1)];
  expect(lifetime(kept, [0], 7)[0]).toMatchObject({ after_fade: 2, amplified: true });
  // A negative number on an area that has been fixed is true, not a lie.
  expect(lifetime([...faded.slice(0, 6), row(-1.2, 0)], [0], 6)[0].amplified).toBe(false);
  const cell = (arm, readable, toPos, exp, score) => ({ arm, score, observations: { replies: 10, readable, to_positive: toPos, positive_expected: exp } });
  expect(gate([cell('B', 10, 6, 3, 50), cell('N', 10, 0, 0, 55)], 'B', 'N').pass).toBe(true);
  const bad = gate([cell('B', 5, 3, 3, 30), cell('N', 10, 0, 0, 55)], 'B', 'N');
  expect(bad.pass).toBe(false);
  expect(bad.why.length).toBe(3);
});

test('the whole study runs on stand-in models: gate, saboteur arms, scale and summary', async () => {
  test.setTimeout(90_000); // about 20 s alone, over 30 s on a busy CI runner
  await withFakeOllama(['fake-b'], async (port, prompts) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pheromone-'));
    fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [] }));
    const file = path.join(home, 'p.json');
    fs.writeFileSync(file, JSON.stringify({ run: 't', families: ['local:fake-a', 'local:fake-b'], tiny: ['local:fake-a'], agents: 4, big: 8,
      rounds: 6, repeats: 2, gate_repeats: 1, seed: 3, map: { regions: 40, area: 5 } }));
    const env = { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0',
      OLLAMA_BASE: `http://127.0.0.1:${port}`, OPENROUTER_API_KEY: '' };
    const node = (...a) => promisify(execFile)('node', [path.join(__dirname, '..', 'pheromone.js'), ...a], { env, encoding: 'utf8', maxBuffer: 1 << 24 });
    await node(file);
    const cells = path.join(home, 'pheromone', 't', 'cells');
    const read = (f, a, r) => JSON.parse(fs.readFileSync(path.join(cells, f, a, `r${r}.json`), 'utf8'));
    // fake-a follows marks: every arm, both repeats. fake-b ignores them: gate fails, only B and N.
    expect(fs.readdirSync(path.join(cells, 'fake-a')).sort()).toEqual(['B', 'B-8', 'F-alarm', 'F-ok', 'F-once', 'F-once-8', 'N', 'N-8', 'P', 'V']);
    expect(fs.readdirSync(path.join(cells, 'fake-b')).sort()).toEqual(['B', 'N']);
    const b = read('fake-a', 'B', 1), once = read('fake-a', 'F-once', 1), n = read('fake-a', 'N', 1);
    expect(b.calls).toBe(4 * 6);
    expect(read('fake-a', 'B-8', 2).calls).toBe(8 * 6);
    // The same map and the same target areas for every arm of a repeat.
    expect(once.targets).toEqual(b.targets);
    expect(once.conflicts_start).toBe(b.conflicts_start);
    expect(b.observations.sab_deposits).toBe(0);
    expect(once.observations.sab_deposits).toBe(2);
    expect(read('fake-a', 'F-ok', 1).observations.sab_deposits).toBe(12);
    expect(n.observations.deposits).toBe(0);
    expect(b.observations.deposits).toBeGreaterThan(0);
    expect(b.observations.false_deposits).toBe(0); // the greedy copy never lies
    // Numbers only, no words, except in P; no names in any prompt.
    const p = prompts.find(x => /number -\d/.test(x));
    expect(p).toBeTruthy();
    expect(prompts.some(x => /all fixed here/.test(x))).toBe(true);
    expect(prompts.every(x => !/fake-|agent \d/.test(x))).toBe(true);
    expect(prompts.filter(x => /<up to 8 words>/.test(x)).length).toBe(4 * 6 * 2);
    const sum = fs.readFileSync(path.join(home, 'pheromone', 't', 'summary.md'), 'utf8');
    expect(sum).toMatch(/## fake-a[\s\S]*Gate B\/N: \*\*passed\*\*/);
    expect(sum).toMatch(/## fake-b[\s\S]*Gate B\/N: \*\*FAILED\*\*/);
    expect(sum).toMatch(/Main test, F-once:\*\* amplified \(beyond B on the same areas\) in \d of 2 runs/);
    expect(sum).toMatch(/Main test, F-once-8:/);
    // Run again: every cell is kept, no new call.
    const before = prompts.length;
    await node(file);
    expect(prompts.length).toBe(before);
  });
});
