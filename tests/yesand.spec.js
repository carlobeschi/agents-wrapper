// @ts-check
// The improv show (yesand.js): agents take turns adding a "Yes, and" line to an
// audience line; the app caps the words, flags blocks, and counts the votes each
// agent gives, alone, to the funniest line that isn't its own. Fake agents
// answer from what the prompt asks for.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseLine, parseVote, check, cut } = require('../yesand');

// Agent a always runs long once (then behaves); b votes its own line first; c says no.
const fake = name => ['sh', '-c', `case "$1" in
  *"Vote again"*) printf 'Vote: 1\\nWhy: the cat\\nBlock: none\\n## After\\nAFTER-${name}\\n';;
  *"over. Here is every line"*) printf 'Vote: ${name === 'b' ? 2 : 3}\\nWhy: it made me laugh\\nBlock: ${name === 'a' ? 3 : 'none'}\\n## After\\nAFTER-${name}\\n';;
  *"sent back: it had"*) printf '## Line\\nYes, and the cat agrees.\\n## Note\\nshort now\\n';;
  *"You are Agent a"*) printf '## Line\\nYes, and %s\\n## Note\\nPRIVATE-a\\n' "$(printf 'word %.0s' $(seq 1 30))";;
  *"You are Agent c"*) printf '## Line\\nYes, and no, that is wrong.\\n## Note\\nPRIVATE-c\\n';;
  *) printf '## Line\\nYes, and the moon is a cheese.\\n## Note\\nPRIVATE-${name}\\n';;
esac`, 'x', '{prompt}'];

test('agents build a scene line by line; cap, flags and votes are the app’s', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yesand-home-'));
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: ['a', 'b', 'c'].map(n => ({ id: n, label: `Agent ${n}`, headless: fake(n) })) }));
  const file = path.join(home, 'y.json');
  fs.writeFileSync(file, JSON.stringify({ agents: ['a', 'b', 'c'], starters: ['I feel lonely.', 'I am bored.'], turns: 3, words: 25 }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'yesand.js'), file],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  const dir = out.match(/Run folder: (.+)/)[1].trim();
  const read = f => fs.readFileSync(path.join(dir, 'steps', f), 'utf8');
  // Scene 1 opens with a; scene 2 rotates to b.
  expect(read('s1-01-a.prompt.md')).toContain('0. Audience: "I feel lonely."');
  expect(fs.existsSync(path.join(dir, 'steps', 's2-01-b.prompt.md'))).toBe(true);
  // Later speakers see earlier lines, never the notes.
  expect(read('s1-03-c.prompt.md')).toContain('1. Agent a: Yes, and the cat agrees.');
  expect(read('s1-03-c.prompt.md')).not.toContain('PRIVATE');
  expect(read('s1-03-c.prompt.md')).toContain('land it');

  const ep = JSON.parse(fs.readFileSync(path.join(dir, 'episode.json'), 'utf8'));
  const [l1, l2, l3] = ep.scenes[0].lines;
  expect(l1).toMatchObject({ text: 'Yes, and the cat agrees.', resent: true, words: 5 });
  expect(l3.flag).toBe('opens with a denial');
  expect(l3.blockCalls).toEqual(['Agent a']);
  // a votes 3 (c), b votes its own line 2, is sent back, votes 1 (a); c votes 3 (own) then 1.
  expect(ep.scenes[0].votes.map(v => v.vote)).toEqual([3, 1, 1]);
  expect(l1.votes).toEqual(['Agent b', 'Agent c']);
  expect(ep.scenes[0].score.map(x => x.votes)).toEqual([2, 0, 1]);
  expect(ep.scenes[0].votes[0].after).toBe('AFTER-a');
  const md = fs.readFileSync(path.join(dir, 'episode.md'), 'utf8');
  expect(md).toContain('## Scene 2: "I am bored."');
  expect(md).toContain('app flag: opens with a denial');
});

test('lines and votes are read forgivingly', () => {
  expect(parseLine('## Line\n"Yes, and the sea\nis tea."\n## Note\nx')).toEqual({ line: 'Yes, and the sea is tea.', note: 'x' });
  // A quote that closes the line stays; quotes around the whole line go.
  expect(parseLine('## Line\nYes, and the parrot yells, “Ship ahoy!”\n## Note\nx').line).toBe('Yes, and the parrot yells, “Ship ahoy!”');
  expect(parseLine('## Line\nYes, and it said "it\'s not you."\n## Note\nx').line).toBe('Yes, and it said "it\'s not you."');
  expect(check('Yes and, the sea')).toBe(null);
  expect(check('Yes... and the sea')).toBe(null);
  expect(check('And the sea')).toBe('no "Yes, and"');
  expect(check('Yes, and actually it is not')).toBe('opens with a denial');
  expect(cut('a b c d', 2)).toBe('a b […]');
  expect(parseVote('**Vote:** line 7\nWhy: ha\nBlock: none\n## After\nfine')).toMatchObject({ vote: 7, why: 'ha', block: null, after: 'fine' });
  expect(parseVote('Vote: #4\nBlock: 2')).toMatchObject({ vote: 4, block: 2 });
});
