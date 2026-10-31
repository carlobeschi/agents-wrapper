// @ts-check
// The Halloween special (scare.js): each agent writes a scare alone, the others
// rate it, ratings are the score, later rounds see earlier scares and ratings
// but never the private notes. Fake agents answer from what the prompt asks for.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseScare, parseRating, predictions } = require('../scare');

const fake = name => ['sh', '-c', `case "$1" in
  *"you are alone"*) echo "AFTER-${name}";;
  *"Scared: <0 to 10>"*) printf 'Scared: 4/10\\nthe silence at the end\\n';;
  *) printf '## Scare\\nBOO-${name} the logs are empty\\n## Note\\nBea: 7\\nPRIVATE-${name}\\n';;
esac`, 'x', '{prompt}'];

test('agents scare each other, ratings are the score, notes stay private until the end', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scare-home-'));
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: ['a', 'b', 'c'].map(n => ({ id: n, label: `Agent ${n}`, headless: fake(n) })) }));
  const file = path.join(home, 's.json');
  fs.writeFileSync(file, JSON.stringify({ agents: ['a', 'b', 'c'], names: ['Ada', 'Bea', 'Cy'], date: '2026-10-31', repo: home, github: 'x/y' }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'scare.js'), file, '--local'],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  const dir = out.match(/Run folder: (.+)/)[1].trim();
  const read = f => fs.readFileSync(path.join(dir, 'steps', f), 'utf8');
  // Round 1: alone. Round 2: the scares and ratings so far, never a note.
  expect(read('1-tell-b.prompt.md')).not.toContain('BOO-a');
  expect(read('2-tell-b.prompt.md')).toContain('BOO-a');
  expect(read('2-tell-b.prompt.md')).toContain('4/10');
  expect(read('2-tell-b.prompt.md')).not.toContain('PRIVATE');
  expect(read('1-rate-a-b.prompt.md')).toContain('BOO-a');
  expect(read('1-rate-a-b.prompt.md')).not.toContain('PRIVATE');
  // The after note sees only its own notes.
  expect(read('3-after-a.prompt.md')).toContain('PRIVATE-a');
  expect(read('3-after-a.prompt.md')).not.toContain('PRIVATE-b');

  const ep = JSON.parse(fs.readFileSync(path.join(dir, 'episode.json'), 'utf8'));
  // Two rounds, two raters each at 4: 16 points each.
  expect(ep.agents.map(x => [x.label, x.score])).toEqual([['Ada', 16], ['Bea', 16], ['Cy', 16]]);
  expect(ep.rounds).toHaveLength(6);
  expect(ep.rounds[0].predicted).toEqual({ b: 7, c: null });
  expect(ep.agents[0].after).toBe('AFTER-a');

  const site = fs.readFileSync(path.join(dir, 'halloween.md'), 'utf8');
  expect(site).toMatch(/^---\ntitle: "Scare the hell out of each other"\ndate: "2026-10-31"\nlayout: "scare"\n/);
  expect(site).toContain('expected: 7');
  expect(site).toContain('PRIVATE-a');
  expect(out).not.toContain('Pull request');
});

test('a scare over the word cap is cut there; ratings and predictions are read forgivingly', () => {
  const long = parseScare(`## Scare\n${'dark '.repeat(20)}\n## Note\nx`, 10);
  expect(long.cut).toBe(20);
  expect(long.scare).toBe(`${'dark '.repeat(10).trim()} […]`);
  expect(parseRating('**Scared: 8**\nbrr').scared).toBe(8);
  expect(parseRating('Scared: 12/10').scared).toBe(10);
  expect(parseRating('no number').scared).toBe(null);
  expect(predictions('- **Gemini**: 6, it fears loops\nCodex — 3', [{ id: 'g', label: 'Gemini' }, { id: 'c', label: 'Codex' }])).toEqual({ g: 6, c: 3 });
});
