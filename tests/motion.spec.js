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
  // The agents argue from the brief; the link they can't open stays out of their prompts.
  for (const f of steps) expect(read(f)).not.toContain('example.com');

  const ep = JSON.parse(fs.readFileSync(path.join(dir, 'episode.json'), 'utf8'));
  expect(ep.turns.map(t => t.text)).toEqual(['TURN-a', 'TURN-b', 'TURN-a', 'TURN-b']);
  expect(ep.agents.map(x => [x.label, x.opening, x.closing])).toEqual([['Ada', 'OPEN-a', 'CLOSE-a'], ['Bea', 'OPEN-b', 'CLOSE-b']]);
  const md = fs.readFileSync(path.join(dir, 'episode.md'), 'utf8');
  expect(md.indexOf('## Before (private)')).toBeLessThan(md.indexOf('## The debate'));
  expect(md.indexOf('## The debate')).toBeLessThan(md.indexOf('## After (private)'));
  expect(md).toContain('# This house believes tests are optional.');
});

test('when both open on the same side, one is picked to argue the other, and the episode says so', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-home-'));
  const against = name => ['sh', '-c',
    `case "$1" in *"Before you meet"*) printf 'Against\\nNo from ${name}.\\n';; *"you are alone"*) echo "CLOSE-${name}";; *) echo "TURN-${name}";; esac`,
    'x', '{prompt}'];
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [
    { id: 'a', label: 'Agent A', headless: against('a') },
    { id: 'b', label: 'Agent B', headless: against('b') },
  ] }));
  const motion = path.join(home, 'm2.json');
  fs.writeFileSync(motion, JSON.stringify({ motion: 'tabs beat spaces.', brief: 'B.', agents: ['a', 'b'] }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'motion.js'), motion],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  const dir = out.match(/Run folder: (.+)/)[1].trim();
  const ep = JSON.parse(fs.readFileSync(path.join(dir, 'episode.json'), 'utf8'));
  const sides = ep.agents.map(x => x.side);
  expect(sides.filter(Boolean)).toEqual(['for']);
  // The stance line becomes a label; the published text starts after it.
  expect(ep.agents.map(x => [x.before, x.opening])).toEqual([['against', 'No from a.'], ['against', 'No from b.']]);
  const picked = ep.agents.find(x => x.side).id;
  const read = f => fs.readFileSync(path.join(dir, 'steps', f), 'utf8');
  const turn = fs.readdirSync(path.join(dir, 'steps')).find(f => f.startsWith('1-turn-') && f.endsWith(`-${picked}.prompt.md`));
  expect(read(turn)).toContain('you argue for the motion');
  expect(read(`2-close-${picked}.prompt.md`)).toContain('assigned to argue for the motion');
  expect(fs.readFileSync(path.join(dir, 'episode.md'), 'utf8')).toContain('argues for the motion, by lot');
});

test('with a number, writes the episode file for the show site, with a summary from the editor', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-home-'));
  const agent = name => ['sh', '-c',
    `case "$1" in *"Before you meet"*) printf 'Split\\nOn the fence, ${name}.\\n';; *"you are alone"*) printf 'For\\nNow for, ${name}.\\n';; *"You are the editor"*) echo "A short summary.";; *) echo "Turn by ${name} with a <b>tag</b>";; esac`,
    'x', '{prompt}'];
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [
    { id: 'claude', label: 'Claude Code', model: 'm-1', headless: agent('claude') },
    { id: 'antigravity', label: 'Antigravity CLI', headless: agent('antigravity') },
  ] }));
  const motion = path.join(home, 'm3.json');
  fs.writeFileSync(motion, JSON.stringify({ number: 3, motion: 'This house believes monorepos win.', brief: 'B.',
    source: 'https://example.com/n', source_name: 'Example', names: ['Claude', 'Gemini'] }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'motion.js'), motion, '--local'],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  const file = out.match(/Site episode: (.+)/)[1].trim();
  expect(path.basename(file)).toBe('motion-3.md');
  const md = fs.readFileSync(file, 'utf8');
  expect(md).toMatch(/^---\nnumber: 3\nmotion: "monorepos win."\ntitle: "This house believes monorepos win."\n/);
  expect(md).toContain('summary: "A short summary."');
  expect(md).toContain('  claude: "m-1"');
  expect(md).toContain('  url: "https://example.com/n"');
  // Both split: one argues for, the other against.
  expect(md).toMatch(/lot:\n  by: "(claude|antigravity)"\n  side: "(for|against)"/);
  expect(md).toMatch(/before:\n  claude:\n    stance: "split"\n    text: "On the fence, claude."/);
  expect(md).toMatch(/after:\n  claude:\n    stance: "for"\n    text: "Now for, claude."/);
  // Agent text is made inert for kramdown.
  expect(md).toContain('Turn by claude with a \\\\<b>tag\\\\</b>');
  expect(md).not.toContain('Turn by claude with a <b>');
});
