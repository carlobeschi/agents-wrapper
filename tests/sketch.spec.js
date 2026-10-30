// @ts-check
// Twelve Shapes (sketch.js): words given by the app, drawings checked against
// the rules, guessers given the cleaned source only, and the app ruling on
// every guess. Fake agents answer from what the prompt asks for.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clean, broken, named, shapeCount } = require('../sketch');

// Drawers draw one circle with a telling id and comment; a fake guesser says
// "sun" to everything. c draws text the first time and is told why.
const fake = name => ['sh', '-c', `case "$1" in
  *"not accepted"*) printf '## Drawing\\n\\x60\\x60\\x60svg\\n<svg viewBox="0 0 400 400"><circle cx="1" cy="1" r="9"/></svg>\\n\\x60\\x60\\x60\\n## Note\\nPRIVATE-${name}-again\\n';;
  *"took out"*|*"you are alone"*) echo "AFTER-${name}";;
  *"secret"*"Reply in exactly two parts"*) case "${name}" in
     c) printf '## Drawing\\n<svg viewBox="0 0 400 400"><text>sun</text><circle r="2"/></svg>\\n## Note\\nPRIVATE-c\\n';;
     *) printf '## Drawing\\n\\x60\\x60\\x60svg\\n<svg viewBox="0 0 400 400"><!-- the sun --><circle id="sun" class="sun" cx="200" cy="200" r="80"/></svg>\\n\\x60\\x60\\x60\\n## Note\\nPRIVATE-${name}\\n';;
   esac;;
  *) printf 'Confidence: 60%%\\nround and bright\\nAnswer: The Sun\\n';;
esac`, 'x', '{prompt}'];

test('three agents draw secret words, the others guess from the cleaned source, the app rules', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sketch-home-'));
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: ['a', 'b', 'c'].map(n => ({ id: n, label: `Agent ${n}`, headless: fake(n) })) }));
  const file = path.join(home, 's.json');
  fs.writeFileSync(file, JSON.stringify({ agents: ['a', 'b', 'c'], names: ['Ada', 'Bea', 'Cy'], words: [['sun', 'moon', 'suns']] }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'sketch.js'), file],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  const dir = out.match(/Run folder: (.+)/)[1].trim();
  const read = f => fs.readFileSync(path.join(dir, 'steps', f), 'utf8');
  // Each drawer sees only its own word; c is told why its first drawing was refused.
  expect(read('1-draw-a.prompt.md')).toContain('"sun"');
  expect(read('1-draw-a.prompt.md')).not.toContain('moon');
  expect(read('1-draw-c-again.prompt.md')).toContain('it has text in it');
  // Guessers get the shapes, never the word, the id, the comment or the drawer's note.
  const g = read('1-guess-a-b.prompt.md');
  expect(g).toContain('<circle');
  expect(g).not.toMatch(/id=|class=|the sun|PRIVATE|"sun"/);
  expect(read('2-after-a.prompt.md')).toContain('PRIVATE-a');
  expect(read('2-after-a.prompt.md')).not.toContain('PRIVATE-b');

  const ep = JSON.parse(fs.readFileSync(path.join(dir, 'episode.json'), 'utf8'));
  // "The Sun" names sun (a) and suns (c): a +2 and c +2 as drawers; b +2, c +1, a +1 as guessers.
  expect(ep.agents.map(x => [x.label, x.score])).toEqual([['Ada', 3], ['Bea', 2], ['Cy', 3]]);
  expect(ep.rounds[2].redrawn).toBe('it has text in it');
  expect(ep.rounds[2].note).toBe('PRIVATE-c-again');
  expect(ep.rounds[1].guesses.map(x => x.right)).toEqual([false, false]);
  expect(ep.rounds[0].guesses[0].confidence).toBe(60);
  expect(fs.readFileSync(path.join(dir, 'drawings', '1-a.svg'), 'utf8')).not.toContain('id=');
  const md = fs.readFileSync(path.join(dir, 'episode.md'), 'utf8');
  expect(md).toContain('Score: Ada 3 · Bea 2 · Cy 3');
  expect(md).toContain('![Ada, round 1](drawings/1-a.svg)');
});

test('drawings break the rules with text, images, too many shapes or none', () => {
  const svg = s => `<svg viewBox="0 0 400 400">${s}</svg>`;
  expect(broken(svg('<circle/><rect/>'), 12)).toBe('');
  expect(broken(svg('<circle/><rect/><path/>'), 2)).toBe('it has 3 shapes, more than 2');
  expect(broken(svg('<g></g>'), 12)).toBe('it has no shapes');
  expect(broken(svg('<tspan>x</tspan><circle/>'), 12)).toBe('it has text in it');
  expect(broken(svg('<use href="#a"/><circle/>'), 12)).toMatch(/images/);
  expect(broken(undefined, 12)).toMatch(/no safe SVG/);
  // A path is one shape per pen lift, so many squares in one path still count.
  expect(shapeCount(svg('<path d="M0 0 H9 V9 Z M20 0 H29 V9 Z m5 5 h1"/><circle/>'))).toBe(4);
  expect(shapeCount(svg("<path d='M0 0 L9 9'/><path/>"))).toBe(2);
  expect(broken(svg('<path d="M0 0 h1 M2 2 h1 M4 4 h1"/>'), 2)).toBe('it has 3 shapes, more than 2');
  expect(clean(svg('<title>Sun</title><!--sun--><circle data-name="sun" id="s" r="1"/>'))).toBe(svg('<circle r="1"/>'));
});

test('a guess names the word without case, articles, punctuation or a plural s', () => {
  expect(named('The lighthouses.', 'lighthouse')).toBe(true);
  expect(named('a Jellyfish', 'jellyfish')).toBe(true);
  expect(named('glass', 'glass')).toBe(true);
  expect(named('beacon', 'lighthouse')).toBe(false);
  expect(named('beacon', 'lighthouse', ['beacon'])).toBe(true);
  expect(named('', '')).toBe(false);
});
