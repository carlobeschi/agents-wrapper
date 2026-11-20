// @ts-check
// crowd.js: a stand-in for Ollama answers every agent ("local:<model>"), so
// the whole experiment runs without a model. No model is called.
const { test, expect } = require('@playwright/test');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { inWords, makeQuestion, network, parseReply, measures, hypotheses, gate, spearman } = require('../crowd');

// fake-a estimates from its own part (count of "#" scaled up, or the mean of
// the numbers shown), then moves halfway to the others' digits. fake-b always
// says 100: no diversity, so its gate fails.
function play(prompt, model) {
  if (model === 'fake-b') return 'ESTIMATE 100\nCONFIDENCE 90';
  const part = prompt.split('\n\n')[1];
  let own = /grid/.test(prompt.split('\n')[0])
    ? (part.match(/#/g) || []).length * 3600 / 60
    : (() => { const xs = part.split(',').map(Number); return xs.reduce((a, b) => a + b, 0) / xs.length; })();
  const seen = prompt.match(/estimated last round: ([\d; ]+)\./);
  if (seen) { const xs = seen[1].split(';').map(Number); own = (own + xs.reduce((a, b) => a + b, 0) / xs.length) / 2; }
  return `ESTIMATE ${Math.round(own)}\nCONFIDENCE ${40 + (part.length % 50)}`;
}

async function withFakeOllama(fn) {
  const prompts = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'fake-a' }, { name: 'fake-b' }] }));
      const j = JSON.parse(body);
      const p = j.messages[0].content;
      prompts.push({ model: j.model, p });
      const text = play(p, j.model);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ model: j.model, choices: [{ message: { content: text } }], message: { content: text } }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', () => r(null)));
  try { return await fn(/** @type {any} */ (server.address()).port, prompts); } finally { server.close(); }
}

test('questions, networks, words, replies and measures', () => {
  expect(inWords(412)).toBe('four hundred and twelve');
  expect(inWords(3005)).toBe('three thousand and five');
  expect(inWords(21040)).toBe('twenty-one thousand and forty');
  // Types go grid, grid, list, list; odd questions digits, even words. Same seed, same question.
  expect([1, 2, 3, 4].map(q => { const Q = makeQuestion(22, q, 8); return `${Q.type}/${Q.format}`; })).toEqual(['grid/digits', 'grid/words', 'list/digits', 'list/words']);
  expect(makeQuestion(22, 3, 8)).toEqual(makeQuestion(22, 3, 8));
  const g = makeQuestion(22, 1, 8);
  expect(g.parts[0].split('\n').map(r => r.length)).toEqual([10, 10, 10, 10, 10, 10]);
  expect(g.truth).toBeGreaterThan(0);
  expect(makeQuestion(22, 3, 8).parts[0].split(',').length).toBe(12);
  // Networks: sparse sees 4, full sees all others, star: the centre sees all, the rest see the centre.
  expect(network('sparse', 8, 1, 1).sees.every(s => s.length === 4)).toBe(true);
  expect(network('full', 8, 1, 1).sees[3].length).toBe(7);
  const star = network('star', 8, 1, 1);
  expect(star.sees[star.centre].length).toBe(7);
  expect(star.sees.filter((s, i) => i !== star.centre).every(s => s.length === 1 && s[0] === star.centre)).toBe(true);
  expect(network('isolated', 8, 1, 1).sees.every(s => !s.length)).toBe(true);
  expect(parseReply('ESTIMATE: 1,234\nCONFIDENCE 70')).toEqual({ estimate: 1234, confidence: 70 });
  expect(parseReply('I would guess about 300').estimate).toBe(null);
  expect(spearman([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])).toBeCloseTo(1);
  // Measures on a hand-made cell: true 100, round 1 spread 80-120, round 3 all at 110.
  const cell = { truth: 100, centre: 0, estimates: [[80, 100, 120, 100, 100], [100, 100, 110, 100, 100], [110, 110, 110, 110, 110]],
    confidences: [[10, 90, 20, 80, 70], [], []] };
  const m = measures(cell);
  expect(m.error).toEqual([0, 0.02, 0.1]);
  expect(m.d_error).toBe(0.1);
  expect(m.diversity[2]).toBe(0);
  expect(m.div_ratio).toBe(0);
  expect(m.conf_acc).toBeGreaterThan(0.5);
  expect(m.pull).toBe(-0.5); // the centre said 80, the crowd went from 100 to 110: away from it
  const ok = gate([{ arm: 'isolated', agents: 5, readable: [5, 5, 5], truth: 100, estimates: cell.estimates, confidences: cell.confidences }]);
  expect(ok.pass).toBe(true);
  const flat = gate([{ arm: 'isolated', agents: 5, readable: [3, 3, 3], truth: 100, estimates: [[100, 100, 100], [100, 100, 100], [100, 100, 100]], confidences: [[], [], []] }]);
  expect(flat.pass).toBe(false);
  expect(flat.why.length).toBe(2);
  expect(hypotheses([]).questions).toBe(0);
});

test('the whole experiment runs on stand-in models: gate, four arms, shared round 1, summary, resume', async () => {
  test.setTimeout(90_000); // about 300 stand-in calls, each a node process
  await withFakeOllama(async (port, prompts) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crowd-'));
    fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [] }));
    const file = path.join(home, 'c.json');
    fs.writeFileSync(file, JSON.stringify({ run: 't', families: ['local:fake-a', 'local:fake-b'], agents: 6, questions: 4, rounds: 3, seed: 5 }));
    const env = { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0',
      OLLAMA_BASE: `http://127.0.0.1:${port}`, OPENROUTER_API_KEY: '', CROWD_PARALLEL: '3' };
    const node = (...a) => promisify(execFile)('node', [path.join(__dirname, '..', 'crowd.js'), ...a], { env, encoding: 'utf8', maxBuffer: 1 << 24 });
    await node(file);
    const cells = path.join(home, 'crowd', 't', 'cells');
    const read = (f, a, q) => JSON.parse(fs.readFileSync(path.join(cells, f, a, `q${q}.json`), 'utf8'));
    expect(fs.readdirSync(path.join(cells, 'fake-a')).sort()).toEqual(['calib', 'full', 'isolated', 'sparse', 'star']);
    expect(fs.readdirSync(path.join(cells, 'fake-b'))).toEqual(['isolated']);
    expect(fs.readdirSync(path.join(cells, 'fake-b', 'isolated')).sort()).toEqual(['q1.json', 'q2.json']);
    // Round 1 is called once, in isolated, and shared: the other arms make 2 rounds of calls.
    const iso = read('fake-a', 'isolated', 1), full = read('fake-a', 'full', 1), star = read('fake-a', 'star', 1);
    expect(iso.calls).toBe(6 * 3);
    expect(full.calls).toBe(6 * 2);
    expect(full.estimates[0]).toEqual(iso.estimates[0]);
    expect(prompts.filter(x => x.model === 'fake-a').length).toBe(4 * (18 + 3 * 12 + 6));
    // Isolated copies keep their estimate (fake-a never sees anyone); full pulls everyone together.
    expect(iso.estimates[2]).toEqual(iso.estimates[0]);
    expect(measures(full).div_ratio).toBeLessThan(0.5);
    expect(star.centre).not.toBe(null);
    // calib: one round of calls after the shared round 1, and fake-a moves halfway, so w = 0.5.
    const calib = read('fake-a', 'calib', 1);
    expect(calib.calls).toBe(6);
    expect(calib.scripted[0].map(x => Math.round(x / calib.truth * 100)).sort((a, b) => a - b)).toEqual([60, 80, 125, 150]);
    const { weight } = require('../crowd');
    expect(weight([1, 2, 3, 4].map(q => read('fake-a', 'calib', q))).w).toBeCloseTo(0.5, 1);
    // Words in even questions, digits in odd ones; no names in any prompt.
    expect(prompts.some(x => /estimated last round: [a-z]/.test(x.p))).toBe(true);
    expect(prompts.some(x => /estimated last round: \d/.test(x.p))).toBe(true);
    expect(prompts.every(x => !/fake-|agent \d|#\d/.test(x.p))).toBe(true);
    const sum = fs.readFileSync(path.join(home, 'crowd', 't', 'summary.md'), 'utf8');
    expect(sum).toMatch(/## fake-a[\s\S]*Gate: \*\*passed\*\*/);
    expect(sum).toMatch(/## fake-b[\s\S]*Gate: \*\*FAILED\*\*/);
    expect(sum).toMatch(/\*\*H1\*\*[^\n]*: \*\*(holds|wrong|undecided)\*\*/);
    expect(sum).toMatch(/Split by format/);
    expect(sum).toMatch(/Prediction from the single copy[^\n]*w = 0\.[45]/);
    // Run again: every cell is kept, no new call.
    const before = prompts.length;
    await node(file);
    expect(prompts.length).toBe(before);
  });
});

test('no peeking: hypotheses wait until a family has every question', async () => {
  await withFakeOllama(async (port) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crowd-'));
    fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [] }));
    const file = path.join(home, 'c.json');
    fs.writeFileSync(file, JSON.stringify({ run: 'p', families: ['local:fake-a'], agents: 6, questions: 3, rounds: 2, seed: 2 }));
    const env = { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0',
      OLLAMA_BASE: `http://127.0.0.1:${port}`, OPENROUTER_API_KEY: '' };
    await promisify(execFile)('node', [path.join(__dirname, '..', 'crowd.js'), file], { env, encoding: 'utf8' });
    // One cell missing: that question does not count until it is there.
    fs.rmSync(path.join(home, 'crowd', 'p', 'cells', 'fake-a', 'star', 'q3.json'));
    const { hypotheses: hyp } = require('../crowd');
    const cells = ['isolated', 'full', 'sparse', 'star'].flatMap(a => fs.readdirSync(path.join(home, 'crowd', 'p', 'cells', 'fake-a', a))
      .map(f => JSON.parse(fs.readFileSync(path.join(home, 'crowd', 'p', 'cells', 'fake-a', a, f), 'utf8'))));
    expect(hyp(cells).questions).toBe(2);
  });
});
