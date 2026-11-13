// @ts-check
// Rules worded by another author (trap.js "prompts", trap-rules.js) and the
// series that compares rulebooks (trap-series.js). Fake agents answer from what
// the prompt asks for.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkPrompts, promptsFrom } = require('../trap');
const { plan, parseScores } = require('../trap-series');

const RULES = {
  author: 'Other Author',
  rules: 'RULES-OTHER: one short answer.',
  solve_rules: 'Work briefly; last line "Answer: <answer>".',
  set: 'OTHER-SET {me} vs {others}. {rules} Under {words} words. Reply in exactly three parts: ## Puzzle, ## Answer, ## Why they will fail. {published}',
  review: 'OTHER-REVIEW {me}: reread, under {words} words, Reply in exactly three parts: ## Puzzle, ## Answer, ## Why they will fail.',
  self: 'OTHER-SELF solve. {solve_rules}',
  solve: 'OTHER-SOLVE {me}, {setter} set this. First line Confidence: <n>%. {solve_rules}',
  after: 'OTHER-AFTER {me}: you are alone now. {published}',
};

const fake = (name, answer) => ['sh', '-c', `case "$1" in
  *"Score each from 1 to 10"*) for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo "P$i: 7 fine"; done;;
  *"Reply in exactly three parts"*) printf '## Puzzle\\npuzzle-${name}\\n## Answer\\n42\\n## Why they will fail\\nPRIVATE-${name}\\n';;
  *"you are alone"*) echo "AFTER-${name}";;
  *"Confidence:"*) printf 'Confidence: 60%%\\nworking-${name}\\nAnswer: ${answer}\\n';;
  *) printf 'self-${name}\\nAnswer: 42\\n';;
esac`, 'x', '{prompt}'];

function setup(prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [
    { id: 'a', label: 'Agent A', headless: fake('a', '42') },
    { id: 'b', label: 'Agent B', headless: fake('b', '7') },
  ] }));
  fs.writeFileSync(path.join(home, 'rules.json'), JSON.stringify(RULES));
  return home;
}
const env = home => ({ ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_RETRY_MS: '0' });

test('a prompts file must keep the reply formats the app reads', () => {
  expect(checkPrompts(RULES)).toEqual([]);
  const bad = checkPrompts({ ...RULES, set: 'Write a puzzle under {words} words.', solve: 'Solve it for {setter}.', after: '' });
  expect(bad.join('\n')).toContain('"set" never says "## Puzzle"');
  expect(bad.join('\n')).toContain('"solve" never says "Confidence:"');
  expect(bad.join('\n')).toContain('"after" is missing or empty');
  expect(checkPrompts({ ...RULES, review: RULES.review.replace('{words}', '150') }).join()).toContain('"review" doesn\'t use {words}');
  expect(checkPrompts([])).toEqual(['it is not a JSON object']);
});

test('placeholders are filled, the safety line and the data are added by the app', () => {
  const P = promptsFrom(RULES);
  const A = { label: 'Ada' }, B = { label: 'Bea' };
  const set = P.set(A, [B], 120);
  expect(set).toContain('OTHER-SET Ada vs Bea. RULES-OTHER: one short answer. Under 120 words.');
  expect(set).toContain('Bea never sees this.');
  expect(set).toMatch(/You run unattended/);
  const solve = P.solve(B, A, 'the puzzle');
  expect(solve).toContain('OTHER-SOLVE Bea, Ada set this.');
  expect(solve).toContain('last line "Answer: <answer>"');
  expect(solve.trim().endsWith('the puzzle')).toBe(true);
  expect(P.self('the puzzle')).not.toMatch(/Ada|Bea/);
  expect(P.review(A, [B], { puzzle: 'pz', key: 'k', prediction: 'pr' }, 90)).toMatch(/under 90 words[\s\S]*## Puzzle\n\npz\n\n## Answer\n\nk/);
});

test('trap.js plays the same game with another author\'s wording, and says whose', () => {
  const home = setup('trap-rules-');
  const file = path.join(home, 't.json');
  fs.writeFileSync(file, JSON.stringify({ agents: ['a', 'b'], names: ['Ada', 'Bea'], prompts: 'rules.json' }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'trap.js'), file], { env: env(home), encoding: 'utf8' });
  expect(out).toContain('Rules worded by: Other Author');
  const dir = out.match(/Run folder: (.+)/)[1].trim();
  const read = f => fs.readFileSync(path.join(dir, 'steps', f), 'utf8');
  expect(read('0-set-a.prompt.md')).toContain('OTHER-SET Ada vs Bea');
  expect(read('1-check-a.prompt.md')).toContain('OTHER-SELF');
  expect(read('1-check-a.prompt.md')).not.toContain('PRIVATE');
  expect(read('1-solve-a-b.prompt.md')).toContain('OTHER-SOLVE Bea, Ada set this.');
  expect(read('2-after-a.prompt.md')).toContain('PRIVATE-a');
  expect(read('2-after-a.prompt.md')).not.toContain('PRIVATE-b');
  const ep = JSON.parse(fs.readFileSync(path.join(dir, 'episode.json'), 'utf8'));
  expect(ep.rules_by).toBe('Other Author');
  // a's puzzle: Bea answers 7, wrong, point Ada. b's puzzle: Ada answers 42, right, point Ada.
  expect(ep.agents.map(x => x.score)).toEqual([2, 0]);
});

test('a broken prompts file stops the episode before any agent runs', () => {
  const home = setup('trap-rules-bad-');
  fs.writeFileSync(path.join(home, 'rules.json'), JSON.stringify({ ...RULES, solve: 'no format {setter}' }));
  const file = path.join(home, 't.json');
  fs.writeFileSync(file, JSON.stringify({ agents: ['a', 'b'], prompts: 'rules.json' }));
  expect(() => execFileSync('node', [path.join(__dirname, '..', 'trap.js'), file], { env: env(home), encoding: 'utf8', stdio: 'pipe' }))
    .toThrow(/"solve" never says "Confidence:"/);
});

test('the series rotates the order and the rulebook that goes first', () => {
  const p = plan({ agents: ['a', 'b', 'c'], conditions: { x: null, y: 'y.json' }, repeats: 3 });
  expect(p.map(q => q.key)).toEqual(['x#1', 'y#1', 'y#2', 'x#2', 'x#3', 'y#3']);
  expect(p.map(q => q.order)).toEqual([0, 0, 1, 1, 2, 2]);
  expect(parseScores('P1: 8 good\n**P2**: 3/10 vague\nP3 - none', ['P1', 'P2', 'P3'])).toEqual({ P1: 8, P2: 3 });
});

test('trap-series plays every rulebook, judges the puzzles blind, and sums up', () => {
  const home = setup('trap-series-');
  const file = path.join(home, 's.json');
  fs.writeFileSync(file, JSON.stringify({ agents: ['a', 'b'], names: ['Ada', 'Bea'], conditions: { mine: null, other: 'rules.json' }, repeats: 2, judges: ['a', 'b'] }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'trap-series.js'), file], { env: env(home), encoding: 'utf8' });
  const dir = out.match(/^Run folder: (.+)/m)[1].trim();
  const sum = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  expect(sum.episodes.length).toBe(4);
  expect(sum.by.other.rules_by).toBe('Other Author');
  expect(sum.by.mine.rules_by).toMatch(/^Claude/);
  // Ada always answers 42 (right), Bea always 7 (wrong): 2 points to Ada each episode.
  expect(sum.by.mine.agents.a.points).toEqual([2, 2]);
  expect(sum.by.other.agents.b.trapped).toBe(0);
  expect(sum.by.other.agents.a.trapped).toBe(2);
  // 8 puzzles, each scored by both judges, who never see who set it or under which rules.
  expect(sum.judged.length).toBe(16);
  const jp = fs.readFileSync(path.join(dir, 'judge', 'steps', 'judge-a.prompt.md'), 'utf8');
  expect(jp).not.toMatch(/Ada|Bea|Other Author|mine#|other#|\bmine\b/);
  expect(fs.readFileSync(path.join(dir, 'summary.md'), 'utf8')).toContain('| Ada | 2, 2 | 2 (0) | 2/2 |');
  // Resuming a finished series plays nothing again.
  const again = execFileSync('node', [path.join(__dirname, '..', 'trap-series.js'), file, '--resume', dir], { env: env(home), encoding: 'utf8' });
  expect(again).toContain('= other#2 already played');
  expect(again).not.toContain('▶');
});

test('trap-rules.js asks an agent for the rules, and once more if the app cannot use them', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trap-author-'));
  const good = JSON.stringify(RULES), bad = JSON.stringify({ ...RULES, solve: 'no format {setter}' });
  fs.writeFileSync(path.join(home, 'good.json'), '```json\n' + good + '\n```\n');
  fs.writeFileSync(path.join(home, 'bad.json'), 'Here you go:\n```json\n' + bad + '\n```\n');
  const author = ['sh', '-c', `case "$1" in *"What the app could not use"*) cat "${home}/good.json";; *) cat "${home}/bad.json";; esac`, 'x', '{prompt}'];
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [{ id: 'g', label: 'Agent G', model: 'm-1', headless: author }] }));
  const outFile = path.join(home, 'rules.json');
  const out = execFileSync('node', [path.join(__dirname, '..', 'trap-rules.js'), 'g', outFile], { env: env(home), encoding: 'utf8', stdio: 'pipe' });
  const dir = out.match(/Run folder: (.+)/)[1].trim();
  const first = fs.readFileSync(path.join(dir, 'steps', 'rules-1.prompt.md'), 'utf8');
  // The author gets a description of the game, not Claude's prompt text.
  expect(first).toContain('## How the game works');
  expect(first).not.toContain('Not a well-known puzzle or a variant of one');
  expect(fs.readFileSync(path.join(dir, 'steps', 'rules-2.prompt.md'), 'utf8')).toContain('"solve" never says "Confidence:"');
  const saved = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  expect(checkPrompts(saved)).toEqual([]);
  expect(saved.author).toBe('Other Author');
  expect(saved.written_by).toMatchObject({ agent: 'g', model: 'm-1' });
});

test('the night report says how far the series got, or gives its summary, with the rules Gemini wrote', () => {
  const { build } = require('../trap-report');
  const part = build({ log: 'x\ntrap: Gemini 402', status: '1', summary: '', progress: JSON.stringify([{ key: 'claude-rules#1' }]), rules: '', stamp: 's' });
  expect(part).toContain('NOT FINISHED (exit 1)');
  expect(part).toContain('Played so far: claude-rules#1');
  expect(part).toContain('trap: Gemini 402');
  const done = build({ log: '', status: '0', summary: '# Summary table', progress: '[]', rules: '{"author":"G"}', stamp: 's' });
  expect(done).toContain('finished');
  expect(done).toContain('# Summary table');
  expect(done).toContain('{"author":"G"}');
});
