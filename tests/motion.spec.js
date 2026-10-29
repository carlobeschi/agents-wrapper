// @ts-check
// The Motion (motion.js): openings and closings are private, the debate is
// shared, and the episode keeps them apart. Fake agents reply with a line that
// says which step they were on.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fake = name => ['sh', '-c',
  `case "$1" in *"Before you meet"*) echo "OPEN-${name}";; *"you are alone"*) echo "CLOSE-${name}";; *) echo "TURN-${name}";; esac`,
  'x', '{prompt}'];

test('runs openings, four turns and closings, each private piece kept from the other agent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-home-'));
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [
    { id: 'a', label: 'Agent A', headless: fake('a') },
    { id: 'b', label: 'Agent B', headless: fake('b') },
  ] }));
  const motion = path.join(home, 'm1.json');
  fs.writeFileSync(motion, JSON.stringify({
    motion: 'This house believes tests are optional.', brief: 'A short brief.', source: 'https://example.com/news',
    agents: ['a', 'b'], names: ['Ada', 'Bea'],
  }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'motion.js'), motion],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  const dir = out.match(/Run folder: (.+)/)[1].trim();
  const steps = fs.readdirSync(path.join(dir, 'steps')).filter(f => f.endsWith('.prompt.md')).sort();
  expect(steps).toEqual([
    '0-open-a.prompt.md', '0-open-b.prompt.md',
    '1-turn-1-a.prompt.md', '1-turn-2-b.prompt.md', '1-turn-3-a.prompt.md', '1-turn-4-b.prompt.md',
    '2-close-a.prompt.md', '2-close-b.prompt.md',
  ]);
  const read = f => fs.readFileSync(path.join(dir, 'steps', f), 'utf8');
  // B's opening is written without anything from A, and B never sees A's private pieces.
  expect(read('0-open-b.prompt.md')).not.toContain('OPEN-a');
  for (const f of steps.filter(f => f.endsWith('-b.prompt.md'))) expect(read(f)).not.toContain('OPEN-a');
  expect(read('1-turn-2-b.prompt.md')).toContain('OPEN-b');
  expect(read('1-turn-2-b.prompt.md')).toContain('TURN-a');
  expect(read('1-turn-4-b.prompt.md')).toContain('the last');
  expect(read('2-close-a.prompt.md')).toContain('TURN-b');
  expect(read('2-close-a.prompt.md')).not.toContain('OPEN-b');

  const ep = JSON.parse(fs.readFileSync(path.join(dir, 'episode.json'), 'utf8'));
  expect(ep.turns.map(t => t.text)).toEqual(['TURN-a', 'TURN-b', 'TURN-a', 'TURN-b']);
  expect(ep.agents.map(x => [x.label, x.opening, x.closing])).toEqual([['Ada', 'OPEN-a', 'CLOSE-a'], ['Bea', 'OPEN-b', 'CLOSE-b']]);
  const md = fs.readFileSync(path.join(dir, 'episode.md'), 'utf8');
  expect(md.indexOf('## Before (private)')).toBeLessThan(md.indexOf('## The debate'));
  expect(md.indexOf('## The debate')).toBeLessThan(md.indexOf('## After (private)'));
  expect(md).toContain('# This house believes tests are optional.');
});
