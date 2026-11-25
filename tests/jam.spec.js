// @ts-check
// The game jam (jam.js) against fake labs: parsing ideas and scores, the
// anonymous ballots, the tally, the permissions of the real commands, and a
// whole run (ideas, vote, builds in branches, vote on builds). No model is called.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LABS, commandFor, labsFor, parseIdeas, parseScores, parseBest, tally, ballot, anonymise, vote1Prompt } = require('../jam');

const FAKE = path.join(__dirname, 'fixtures', 'jam', 'fake.js');

test('ideas and scores are parsed from loose replies', () => {
  const ideas = parseIdeas('Here you go:\n1. **IDEA:** Rain boots\n**WHAT:** the cat\nputs on boots.\nWHY: splash\n\nIDEA: No what\nWHY: x\n- IDEA – Kite\nWHAT: fly it\nWHY: wind');
  expect(ideas).toEqual([{ title: 'Rain boots', what: 'the cat puts on boots.', why: 'splash' }, { title: 'Kite', what: 'fly it', why: 'wind' }]);
  expect(parseScores('I1: 7 - nice\n**I2** | 9/10 | great\nI3: 11 - no\nI9: 5 - out of range\nI1: 2 - again', 'I', 4))
    .toEqual({ 1: { score: 7, why: 'nice' }, 2: { score: 9, why: 'great' } });
  expect(parseScores('A: 8 - good\n**B**: 6 – meh\nBEST: A - tidy', '', 0)).toEqual({ A: { score: 8, why: 'good' }, B: { score: 6, why: 'meh' } });
  expect(parseBest('A: 8\n**BEST:** B - tidier')).toEqual({ letter: 'B', why: 'tidier' });
  expect(anonymise('Claude said GPT-6 and Gemini and Mistral Vibe agree')).toBe('an agent said an agent and an agent and an agent an agent agree');
});

test('a voter never sees its own ideas, sees no names, and the tally ranks by average', () => {
  const items = ['a', 'a', 'b', 'c'].map((lab, key) => ({ key, lab, title: `t${key} by Claude`, what: 'w', why: 'y' }));
  const shown = ballot(items, 'a', 's');
  expect(shown.map(i => i.lab).sort()).toEqual(['b', 'c']);
  expect(ballot(items, 'a', 's')).toEqual(shown);
  const p = vote1Prompt({ title: 'G', about: 'A game.', game: 'g.html', build_top: 2 }, shown);
  expect(p).not.toContain('Claude');
  expect(p).toContain('none of them is yours');
  const t = tally(items, { b: { 0: { score: 4 }, 1: { score: 8 } }, c: { 0: { score: 6 }, 1: { score: 8 }, 2: { score: 9 } } });
  expect(t.map(r => [r.key, r.mean, r.n])).toEqual([[2, 9, 1], [1, 8, 2], [0, 5, 2], [3, null, 0]]);
});

test('the real commands: read-only to read, file edits only to build, no loosening flags, models filled or dropped', () => {
  expect(commandFor(LABS.claude, 'read', { model: 'm1' })).toEqual(['claude', '-p', '--model', 'm1', '--tools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk', '--strict-mcp-config']);
  expect(LABS.claude.build.join(' ')).toContain('--tools Read,Edit,Write,Glob,Grep --permission-mode acceptEdits');
  expect(commandFor(LABS.codex, 'read', {})).not.toContain('-m');
  expect(commandFor(LABS.codex, 'build', { model: 'x' }).join(' ')).toContain('-s workspace-write');
  expect(commandFor(LABS.codex, 'build', { model: 'x' }).join(' ')).toContain('network_access=false');
  const agyRead = JSON.parse(LABS.gemini.read[LABS.gemini.read.indexOf('--settings') + 1]);
  const agyBuild = JSON.parse(LABS.gemini.build[LABS.gemini.build.indexOf('--settings') + 1]);
  expect(agyRead.permissions.deny).toContain('write_file(*)');
  expect(agyBuild.permissions.deny).toEqual(expect.arrayContaining(['command(*)', 'read_url(*)']));
  const vibe = commandFor(LABS.mistral, 'build', { price: 2, steps: '/s' });
  expect(vibe.filter((s, i) => vibe[i - 1] === '--enabled-tools')).toEqual(['read_file', 'grep', 'write_file', 'search_replace']);
  expect(vibe).not.toContain('--model');
  expect(vibe.join(' ')).toContain('--max-price 2');
  for (const l of Object.values(LABS)) for (const m of ['read', 'build']) expect(l[m].join(' ')).not.toMatch(/dangerously|bypass|yolo|auto-approve|full-access/);
  expect(() => labsFor({ labs: ['codex'], commands: { codex: { read: ['codex', 'exec', '--dangerously-bypass-approvals-and-sandbox'], build: ['x'] } } })).toThrow(/refused/);
  expect(() => labsFor({ labs: ['mistral'], commands: { mistral: { read: ['vibe', '--enabled-tools', 'bash'], build: ['x'] } } })).toThrow(/refused|shell/);
  expect(labsFor({ labs: ['mistral'], models: { mistral: 'devstral-x' } })[0].model).toBe('devstral-x');
});

test('a whole jam with three fake labs: ideas, vote, a branch each, vote on builds, summary', () => {
  test.setTimeout(120000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-home-'));
  const game = path.join(home, 'game');
  fs.mkdirSync(game);
  fs.writeFileSync(path.join(game, 'g.html'), '<!doctype html><title>g</title><body>cat</body>\n');
  fs.writeFileSync(path.join(game, 'README.md'), '# G\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: game });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: game });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base'], { cwd: game });
  const fake = n => ({ label: n.toUpperCase(), read: ['node', FAKE, 'read', n], build: ['node', FAKE, 'build', n] });
  const cfg = path.join(home, 'jam.json');
  fs.writeFileSync(cfg, JSON.stringify({ title: 'G', about: 'A game.', game: 'g.html', repo: game, labs: ['a', 'b', 'c'], seed: 1,
    commands: { a: fake('a'), b: fake('b'), c: fake('c') } }));
  const out = path.join(home, 'run');
  const run = () => execFileSync('node', [path.join(__dirname, '..', 'jam.js'), cfg, `--out=${out}`], { env: { ...process.env, AGENT_DISPATCH_HOME: home }, encoding: 'utf8', timeout: 100000 });
  run();
  const R = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
  expect(R.ideas).toHaveLength(9);
  expect(R.ideas[0]).toMatchObject({ id: 'a-1', lab: 'a', title: 'a idea 1', what: 'the child taps and smiles 1.' });
  // Every "idea 2" got 9 from both others; they tie on average and count, so the first ones win.
  expect(R.winners).toEqual(['a-2', 'b-2']);
  for (const [v, got] of Object.entries(R.votes1)) for (const k of Object.keys(got)) expect(R.ideas[Number(k)].lab).not.toBe(v);
  expect(R.builds.a.files.sort()).toEqual(['extra.txt', 'g.html']);
  expect(R.builds.a.outside).toEqual(['extra.txt']);
  expect(R.builds.b.check.checked).toBe(true);
  expect(R.builds.b.new_errors).toEqual([]);
  expect(execFileSync('git', ['branch', '--list', 'jam/*'], { cwd: path.join(out, 'repo'), encoding: 'utf8' })).toContain('jam/c');
  expect(fs.readFileSync(path.join(out, 'patches', 'b.patch'), 'utf8')).toContain('b built it');
  // The builders' notes are shown without lab names; nobody scores its own build.
  const seen = fs.readdirSync(path.join(out, 'vote2', 'a'));
  expect(seen).toEqual(['A', 'B']);
  expect(fs.readFileSync(path.join(out, 'vote2', 'a', 'A', 'notes.md'), 'utf8')).toContain('(an agent)');
  expect(R.votes2.a).not.toHaveProperty('a');
  expect(R.build_ranking[0]).toMatchObject({ lab: 'a', mean: 8, n: 2 });
  const md = fs.readFileSync(path.join(out, 'summary.md'), 'utf8');
  expect(md).toContain('| 1 ✓ | a idea 2 | A | 9.0 | (own) | 9 | 9 |');
  expect(md).toContain('| A | 8.0 | (own) | 8 | 8 |');
  // A second run with the same folder reuses every reply.
  const again = run();
  expect(again).not.toContain('✓ ideas/');
  fs.rmSync(home, { recursive: true, force: true });
});
