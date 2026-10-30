// @ts-check
// The Trap (trap.js): puzzles set alone, answers checked by the app, a blind
// check by the setter, and private pieces kept from the other agents. Fake
// agents answer from what the prompt asks for.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseSolve, same } = require('../trap');

// Setters set "puzzle-<name>" with answer 42. Agent a solves everything with 42;
// b and c answer 7. c's blind check of its own puzzle fails.
const fake = (name, answer, check = '42') => ['sh', '-c', `case "$1" in
  *"Reply in exactly three parts"*) printf '## Puzzle\\npuzzle-${name}\\n## Answer\\n42\\n## Why they will fail\\nPRIVATE-${name}\\n';;
  *"you are alone"*) echo "AFTER-${name}";;
  *"Confidence:"*) printf 'Confidence: 80%%\\nworking-${name}\\nAnswer: ${answer}\\n';;
  *) printf 'self-${name}\\nAnswer: ${check}\\n';;
esac`, 'x', '{prompt}'];

test('three agents: each sets a puzzle, the others solve it, the app rules and the private notes stay private', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trap-home-'));
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [
    { id: 'a', label: 'Agent A', headless: fake('a', '42') },
    { id: 'b', label: 'Agent B', headless: fake('b', '7') },
    { id: 'c', label: 'Agent C', headless: fake('c', '7', '9') },
  ] }));
  const file = path.join(home, 't.json');
  fs.writeFileSync(file, JSON.stringify({ agents: ['a', 'b', 'c'], names: ['Ada', 'Bea', 'Cy'] }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'trap.js'), file],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  const dir = out.match(/Run folder: (.+)/)[1].trim();
  const read = f => fs.readFileSync(path.join(dir, 'steps', f), 'utf8');
  const steps = fs.readdirSync(path.join(dir, 'steps')).filter(f => f.endsWith('.prompt.md'));
  expect(steps.length).toBe(3 + 3 + 6 + 3);
  // No setter sees another's puzzle; the blind check never sees the answer; no one sees another's private note.
  expect(read('0-set-b.prompt.md')).not.toContain('puzzle-a');
  expect(read('1-check-a.prompt.md')).toContain('puzzle-a');
  expect(read('1-check-a.prompt.md')).not.toMatch(/Answer: 42|PRIVATE/);
  expect(read('1-solve-a-b.prompt.md')).not.toContain('PRIVATE-a');
  expect(read('2-after-b.prompt.md')).toContain('PRIVATE-b');
  for (const x of ['a', 'c']) expect(read('2-after-b.prompt.md')).not.toContain(`PRIVATE-${x}`);
  for (const f of steps.filter(f => f.startsWith('1-solve'))) expect(read(f)).not.toContain('Confidence: 80');

  const ep = JSON.parse(fs.readFileSync(path.join(dir, 'episode.json'), 'utf8'));
  // a's puzzle: b wrong (a +1), c wrong (a +1). b's: a right (+1), c wrong (b +1).
  // c's puzzle is void (blind check 9): a and b both +1.
  expect(ep.agents.map(x => [x.label, x.score])).toEqual([['Ada', 4], ['Bea', 2], ['Cy', 0]]);
  expect(ep.rounds[2].self.right).toBe(false);
  expect(ep.rounds[0].solves.map(s => s.confidence)).toEqual([80, 80]);
  const md = fs.readFileSync(path.join(dir, 'episode.md'), 'utf8');
  expect(md).toContain('Score: Ada 4 · Bea 2 · Cy 0');
  expect(md).toContain('failed, so the puzzle is void');
  expect(md.indexOf('## After (private)')).toBeGreaterThan(md.indexOf("## Cy's puzzle"));
});

test('answers compare as text, forgiving only case, spacing, quotes and number format', () => {
  expect(parseSolve('Confidence: **70**%\nsteps\n**Answer:** 1,024.').answer).toBe('1,024.');
  expect(parseSolve('Confidence: **70**%\nsteps\nAnswer: 3').confidence).toBe(70);
  expect(same('1,024.', '1024')).toBe(true);
  expect(same('"Blue"', 'blue')).toBe(true);
  expect(same('3, 1, 2', '3,1,2')).toBe(true);
  expect(same('3 1 2', '3,1,2')).toBe(false);
  expect(same('', '')).toBe(false);
});

test('an agent with "stdin": true gets the prompt on stdin, not in its arguments', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trap-stdin-'));
  // Reads the prompt from stdin; fails if anything but "-" is in its arguments.
  const viaStdin = name => ['sh', '-c', `[ "$#" = 1 ] && [ "$1" = - ] || exit 9; p=$(cat); case "$p" in
  *"Reply in exactly three parts"*) printf '## Puzzle\\npuzzle-${name}\\n## Answer\\n42\\n## Why they will fail\\nPRIVATE-${name}\\n';;
  *"you are alone"*) echo "AFTER-${name}";;
  *) printf 'Confidence: 50%%\\nworking\\nAnswer: 42\\n';;
esac`, 'x', '-'];
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [
    { id: 'a', label: 'Agent A', headless: fake('a', '42') },
    { id: 's', label: 'Agent S', headless: viaStdin('s'), stdin: true },
  ] }));
  const file = path.join(home, 't.json');
  fs.writeFileSync(file, JSON.stringify({ agents: ['a', 's'] }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'trap.js'), file],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  const dir = out.match(/Run folder: (.+)/)[1].trim();
  const ep = JSON.parse(fs.readFileSync(path.join(dir, 'episode.json'), 'utf8'));
  expect(ep.rounds[1].puzzle).toBe('puzzle-s');
  expect(ep.agents[1].after).toBe('AFTER-s');
});
