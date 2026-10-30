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
  fs.writeFileSync(file, JSON.stringify({ agents: ['a', 'b', 'c'], names: ['Ada', 'Bea', 'Cy'], words: [['sun', 'moon', 'suns']],
    kinds: ['things'], number: 2, date: '2026-10-31', repo: home, github: 'x/y' }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'sketch.js'), file, '--local'],
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

  // The file for the show site: score, every drawing as text, the private pieces; no pull request with --local.
  expect(out).not.toContain('Pull request');
  const site = fs.readFileSync(path.join(dir, 'episode-2.md'), 'utf8');
  expect(site).toMatch(/^---\nnumber: 2\ntitle: "Episode 2"\ndate: "2026-10-31"\n/);
  expect(site).toContain('score:\n  a: 3\n  b: 2\n  c: 3');
  expect(site).toContain('kind: "things"');
  expect(site).toContain('<circle cx=\\"200\\"');
  expect(site).toContain('redrawn: "it has text in it"');
  expect(site).toContain('note: "PRIVATE-a"');
  expect(site).toContain('a: "AFTER-a"');
});

test('a drawing that is out twice is kept for the episode, and no one is asked to guess it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sketch-out-'));
  const big = `<svg viewBox="0 0 400 400">${'<circle r="1"/>'.repeat(3)}</svg>`;
  const draws = ['sh', '-c', `case "$1" in *"you are alone"*) echo AFTER;; *"secret"*) printf '## Drawing\\n${big}\\n## Note\\nN\\n';; *) printf 'Confidence: 5%%\\nAnswer: x\\n';; esac`, 'x', '{prompt}'];
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: ['a', 'b'].map(n => ({ id: n, label: n, headless: draws })) }));
  const file = path.join(home, 's.json');
  fs.writeFileSync(file, JSON.stringify({ agents: ['a', 'b'], shapes: 2, words: [['sun', 'moon']] }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'sketch.js'), file],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  const dir = out.match(/Run folder: (.+)/)[1].trim();
  const ep = JSON.parse(fs.readFileSync(path.join(dir, 'episode.json'), 'utf8'));
  expect(ep.rounds[0].out).toBe('it has 3 shapes, more than 2');
  expect(ep.rounds[0].guesses).toEqual([]);
  expect(fs.readFileSync(path.join(dir, ep.rounds[0].file), 'utf8')).toContain('<circle');
  expect(fs.readdirSync(path.join(dir, 'steps')).some(f => f.includes('guess'))).toBe(false);
  expect(fs.readFileSync(path.join(dir, 'episode.md'), 'utf8')).toContain('![a, round 1, out](drawings/1-a-out.svg)');
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
