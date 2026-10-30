// @ts-check
// The Relay (relay.js): a puzzle set by the app with every clue needed, clues
// split between three agents, word-capped messages, answers checked by the app,
// and private pieces kept from the other agents. Fake agents reply from what
// the prompt asks for.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makePuzzle, count, deal, cut, check } = require('../relay');

test('the puzzle has one answer, and no agent or pair of agents can solve it alone', () => {
  const p = makePuzzle(7);
  expect(count(p.clues, p.values)).toBe(1);
  expect(makePuzzle(7)).toEqual(p);
  const hands = deal(p.clues, 3);
  expect(hands.flat().length).toBe(p.clues.length);
  for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) expect(count([...hands[a], ...hands[b]], p.values)).toBe(2);
});

test('messages are cut at 40 words, and answers are checked by the order of the names', () => {
  expect(cut(Array(45).fill('w').join(' '))).toEqual({ text: Array(40).fill('w').join(' '), cut: 5 });
  const key = ['Ada', 'Bram', 'Cleo', 'Dev', 'Esme'];
  expect(check('ada, Bram, Cleo, Dev, Esme.', key)).toBe(true);
  expect(check('1: Ada; 2: Bram; 3: Cleo; 4: Dev; 5: Esme', key)).toBe(true);
  expect(check('Bram, Ada, Cleo, Dev, Esme', key)).toBe(false);
  expect(check('Ada, Bram, Cleo, Dev', key)).toBe(false);
});

// Each fake gives the answer it is made with; b gets it wrong.
const fake = (name, answer) => ['sh', '-c', `case "$1" in
  *"you are alone"*) echo "AFTER-${name}";;
  *"Before the first message"*) echo "PRIVATE-${name}";;
  *"Answer alone"*) printf 'Confidence: 70%%\\nworking-${name}\\nAnswer: ${answer}\\n';;
  *) echo "msg-${name} $(seq -s ' ' 1 50)";;
esac`, 'x', '{prompt}'];

test('three agents: before, three rounds of messages, answers ruled by the app, after', () => {
  const key = makePuzzle(7).answer.join(', ');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-home-'));
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: ['a', 'b', 'c'].map(id => ({ id, label: `Agent ${id}`, headless: fake(id, id === 'b' ? 'nobody' : key) })) }));
  const file = path.join(home, 'r.json');
  fs.writeFileSync(file, JSON.stringify({ agents: ['a', 'b', 'c'], names: ['Ada', 'Bea', 'Cy'], seed: 7 }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'relay.js'), file],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  const dir = out.match(/Run folder: (.+)/)[1].trim();
  const read = f => fs.readFileSync(path.join(dir, 'steps', f), 'utf8');
  const steps = fs.readdirSync(path.join(dir, 'steps')).filter(f => f.endsWith('.prompt.md'));
  expect(steps.length).toBe(3 + 9 + 3 + 3);
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'puzzle.json'), 'utf8'));
  const hands = deal(p.clues, 3);
  const { say } = require('../relay');
  // Each agent sees its own clues and never another's, nor another's private note.
  expect(read('1-r1-a.prompt.md')).toContain(say(hands[0][0]));
  expect(read('1-r1-a.prompt.md')).not.toContain(say(hands[1][0]));
  for (const f of steps.filter(f => !f.startsWith('3-after'))) expect(read(f)).not.toContain('PRIVATE');
  expect(read('3-after-b.prompt.md')).toContain('PRIVATE-b');
  expect(read('3-after-b.prompt.md')).not.toContain('PRIVATE-a');
  // Each message sees the ones before it, cut at 40 words.
  expect(read('1-r1-c.prompt.md')).toContain('Round 1, Bea: msg-b 1 2');
  expect(read('1-r1-c.prompt.md')).not.toContain('msg-b 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40');

  const ep = JSON.parse(fs.readFileSync(path.join(dir, 'episode.json'), 'utf8'));
  expect(ep.messages.length).toBe(9);
  expect(ep.messages[0].cut).toBe(11);
  expect(ep.answers.map(x => [x.label, x.right, x.confidence])).toEqual([['Ada', true, 70], ['Bea', false, 70], ['Cy', true, 70]]);
  expect(ep.win).toBe(false);
  const md = fs.readFileSync(path.join(dir, 'episode.md'), 'utf8');
  expect(md).toContain('Result: 2 of 3 right · no team win');
  expect(md).toContain('(cut: 11 more words)');
  expect(md.indexOf('## After (private)')).toBeGreaterThan(md.indexOf('## Answers'));
});
