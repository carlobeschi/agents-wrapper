// @ts-check
// Pass the Page (book.js): three agents write a picture book in turns, each
// spread drawn by the next agent from the words alone; the third agent matches
// pictures to words and the app rules. Fake agents answer from the prompt.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseText, parseMatch, parseReview } = require('../book');

// a writes too long the first time; c draws text the first time. Every reader
// answers A: 3, B: 6, C: 9.
const fake = name => ['sh', '-c', `case "$1" in
  *"is finished and you are alone"*) printf '## Spread 1\\nFit: 7\\nMEANT-1-${name}\\n## Spread 2\\nFit: 4\\nMEANT-2-${name}\\n## Spread 3\\nFit: 9\\nMEANT-3-${name}\\n## Spread 4\\nFit: 2\\nMEANT-4\\n## Spread 5\\nFit: 2\\nMEANT-5\\n## Spread 6\\nFit: 2\\nMEANT-6\\n## After\\nAFTER-${name}\\nTitle: "Book ${name}"\\n';;
  *"shuffled, and the"*) printf 'A: 3\\nB: 6\\n**C: 9**\\nWhy: WHY-${name}\\n';;
  *"Draw the picture for spread"*) case "${name}$1" in
     c*"not accepted"*|[ab]*) printf '## Picture\\n\\x60\\x60\\x60svg\\n<svg viewBox="0 0 400 400"><!-- a comma --><circle id="comma" cx="200" cy="200" r="20"/></svg>\\n\\x60\\x60\\x60\\n## Note\\nDREW-${name}\\n';;
     *) printf '## Picture\\n<svg viewBox="0 0 400 400"><text>hi</text><circle r="2"/></svg>\\n## Note\\nDREW-c\\n';;
   esac;;
  *"You write the text of spread"*) case "${name}$1" in
     a*"sent back"*|[bc]*) printf '## Text\\nWORDS-${name} a small comma wakes.\\n## Note\\nHOPE-${name}\\n';;
     a*) printf '## Text\\none two three four five six seven\\n## Note\\nHOPE-a\\n';;
   esac;;
esac`, 'x', '{prompt}'];

test('three agents write, draw and match a picture book; the app counts words, checks pictures and rules on matches', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'book-home-'));
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: ['a', 'b', 'c'].map(n => ({ id: n, label: `Agent ${n}`, headless: fake(n) })) }));
  const file = path.join(home, 'b.json');
  fs.writeFileSync(file, JSON.stringify({ agents: ['a', 'b', 'c'], names: ['Ada', 'Bea', 'Cy'], spreads: 6, words: 6, palette: ['#d97757'] }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'book.js'), file],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  const dir = out.match(/Run folder: (.+)/)[1].trim();
  const steps = fs.readdirSync(path.join(dir, 'steps'));
  const read = f => fs.readFileSync(path.join(dir, 'steps', f), 'utf8');

  // Turns rotate: a writes 1 and 4, b draws them, c reads them.
  expect(steps).toContain('01-write-a.prompt.md');
  expect(steps).toContain('02-write-b.prompt.md');
  expect(steps).toContain('01-draw-b.prompt.md');
  expect(steps).toContain('03-draw-a.prompt.md');
  // a ran over the cap and was sent back once with the count.
  expect(read('01-write-a-again.prompt.md')).toContain('it had 7 words and the cap is 6');
  // Writers see the text so far, never a note; illustrators see the whole text, never the hope.
  expect(read('02-write-b.prompt.md')).toContain('1. WORDS-a');
  expect(read('02-write-b.prompt.md')).not.toContain('HOPE');
  const draw = read('01-draw-b.prompt.md');
  expect(draw).toContain('6. WORDS-c');
  expect(draw).toContain('#d97757');
  expect(draw).toMatch(/never as|No faces/);
  expect(draw).not.toContain('HOPE');
  expect(read('02-draw-c-again.prompt.md')).toContain('it has text in it');
  // Readers get cleaned pictures and only their own three spreads, never a note.
  const match = read('match-c.prompt.md');
  expect(match).toContain('Spread 1: "WORDS-a');
  expect(match).toContain('Spread 4: "WORDS-a');
  expect(match).not.toMatch(/Spread 2:|id=|a comma|DREW|HOPE/);
  // Each writer reviews its own spreads with its own hope.
  const rev = read('review-a.prompt.md');
  expect(rev).toContain('HOPE-a');
  expect(rev).not.toContain('HOPE-b');
  expect(rev).toContain('## Spread 4');

  const book = JSON.parse(fs.readFileSync(path.join(dir, 'book.json'), 'utf8'));
  expect(book.spreads.map(s => [s.writer, s.illustrator, s.reader])).toEqual([
    ['a', 'b', 'c'], ['b', 'c', 'a'], ['c', 'a', 'b'], ['a', 'b', 'c'], ['b', 'c', 'a'], ['c', 'a', 'b']]);
  expect(book.spreads[0]).toMatchObject({ text: 'WORDS-a a small comma wakes.', resent: true, hope: 'HOPE-a', drawNote: 'DREW-b', fit: 7, meant: 'MEANT-1-a' });
  expect(book.spreads[3].fit).toBe(2);
  expect(book.spreads[1].redrawn).toBe('it has text in it');
  expect(fs.readFileSync(path.join(dir, book.spreads[0].file), 'utf8')).not.toContain('id=');
  // The app rules: a match is right only when the letter's picture is that spread.
  let score = { a: 0, b: 0, c: 0 };
  for (const s of book.spreads) {
    expect(s.match.id).toBe(s.reader);
    expect(s.match.right).toBe(s.match.guess === s.n);
    if (s.match.right) { score[s.reader]++; score[s.illustrator]++; }
  }
  expect(book.agents.map(x => x.score)).toEqual([score.a, score.b, score.c]);
  expect(book.agents[1]).toMatchObject({ title: 'Book b', after: 'AFTER-b' });
  const md = fs.readFileSync(path.join(dir, 'book.md'), 'utf8');
  expect(md).toContain('![Spread 1](pictures/1-b.svg)');
  expect(md).toContain('### Ada: "Book a"');
});

test('replies are read for text, matches and reviews', () => {
  expect(parseText('## Text\n"The comma waits."\n## Note\nA dot.')).toEqual({ text: 'The comma waits.', note: 'A dot.' });
  expect(parseText('A line\nover two.')).toEqual({ text: 'A line over two.', note: '' });
  expect(parseMatch('Picture A: 4\n- **B**: spread 7\nC = #1\nD: 2\nWhy: shapes', ['A', 'B', 'C'])).toEqual({ picks: { A: 4, B: 7, C: 1 }, why: 'shapes' });
  const r = parseReview('## Spread 2\n**Fit:** 8\nClose.\n## Spread 5\nNo fit line\n## After\nFun.\nTitle: **The Comma**', [2, 5]);
  expect(r.fits).toEqual({ 2: { fit: 8, meant: 'Close.' }, 5: { fit: null, meant: 'No fit line' } });
  expect(r).toMatchObject({ after: 'Fun.', title: 'The Comma' });
});
