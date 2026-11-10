// @ts-check
// Solo vs together (study.js): each agent alone, then together, judged blind;
// then before / practice / with-lessons runs for each agent, judged blind.
// Fake agents answer from the prompt.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shuffle, parseScores } = require('../study');

const fake = name => ['sh', '-c', `case "$1" in
  *"Score each from 1 to 10"*) printf 'A: 4 | flat\\nB: 8 | lively\\nC: 6 | fine\\nBEST: B\\n';;
  *"just finished"*) printf 'AFTER-${name}\\nLESSON: ${name} saw a trick\\n';;
  *) printf 'INSERT AFTER 0\\nline by ${name}\\nEND\\nSTATUS: done\\n';;
esac`, 'x', '{prompt}'];

test('shuffle is a stable permutation; scores parse from judge replies', () => {
  const a = shuffle(['x', 'y', 'z', 'w'], 'seed');
  expect([...a].sort()).toEqual(['w', 'x', 'y', 'z']);
  expect(shuffle(['x', 'y', 'z', 'w'], 'seed')).toEqual(a);
  const r = parseScores('**A**: 7/10 | good\nB. 3 | weak\nnoise\nBEST: A', ['A', 'B']);
  expect(r.scores).toEqual({ A: 7, B: 3 });
  expect(r.best).toBe('A');
});

test('a study runs alone and together, judges blind, and carries lessons into the learning runs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'study-home-'));
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: ['a', 'b'].map(n => ({ id: n, label: `Agent ${n}`, headless: fake(n) })) }));
  const file = path.join(home, 's.json');
  fs.writeFileSync(file, JSON.stringify({ title: 'T', agents: ['a', 'b'], judges: ['a'], room: { moves: 1, min_moves: 0 },
    repeats: 2, tasks: [{ id: 'sea', kind: 'poem', brief: 'a poem about the sea', roles: ['JOB-ONE', 'JOB-TWO'] }, { id: 'pic', kind: 'scratchpad', brief: 'notes' }],
    learn: { id: 'moon', kind: 'poem', brief: 'a poem about the moon' } }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'study.js'), file],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  const dir = out.match(/Study folder: (.+)/)[1].trim();
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'study.json'), 'utf8'));
  const t = s.tasks[0];
  expect(t.repeats.length).toBe(2);
  expect(Object.keys(t.repeats[0].runs)).toEqual(['a alone', 'b alone', 'together', 'together, roles']);
  // Jobs swap on the second repeat, and everyone sees both jobs.
  expect(t.repeats[0].roles).toEqual({ a: 'JOB-ONE', b: 'JOB-TWO' });
  expect(t.repeats[1].roles).toEqual({ b: 'JOB-ONE', a: 'JOB-TWO' });
  const rp = fs.readFileSync(path.join(t.repeats[0].runs['together, roles'].dir, 'steps', '01-a.prompt.md'), 'utf8');
  expect(rp).toContain('- You: JOB-ONE');
  expect(rp).toContain('- Agent b: JOB-TWO');
  // The first job moves first: b opens the second repeat.
  expect(fs.existsSync(path.join(t.repeats[1].runs['together, roles'].dir, 'steps', '01-b.prompt.md'))).toBe(true);
  // The judge saw three unlabelled pieces and scored every one.
  const jp = fs.readFileSync(path.join(dir, 'steps', 'judge-sea-1-a.prompt.md'), 'utf8');
  expect(jp).toContain('--- D ---');
  expect(jp).not.toMatch(/alone|together|Agent a|Agent b|JOB-/);
  expect(t.repeats[0].judgings[0].pieces.map(p => p.score).filter(x => x != null).sort()).toEqual([4, 6, 8]);
  expect(Object.values(t.best).reduce((x, y) => x + y, 0)).toBe(2);
  // A solo prompt has no partner in it.
  const soloRun = t.repeats[0].runs['a alone'].dir;
  const p1 = fs.readFileSync(path.join(soloRun, 'steps', '01-a.prompt.md'), 'utf8');
  expect(p1).toContain('on your own');
  expect(p1).not.toContain('Agent b');
  // Lessons from poem pairs only (not the scratchpad task) reach only the "with lessons" run.
  expect(s.learn.lessons.a).toEqual(Array(4).fill('a saw a trick'));
  expect(s.learn.agents.a.repeats.length).toBe(2);
  const la = s.learn.agents.a.repeats[0].runs;
  expect(fs.readFileSync(path.join(la.lessons.dir, 'steps', '01-a.prompt.md'), 'utf8')).toContain('a saw a trick');
  expect(fs.readFileSync(path.join(la.practice.dir, 'steps', '01-a.prompt.md'), 'utf8')).not.toContain('saw a trick');
  expect(fs.readFileSync(path.join(dir, 'summary.md'), 'utf8')).toContain('Did they learn from each other?');
});

test('study 3: same-model pairs, a checker who can only talk, checks scored, and a puzzle with a diagnosis of each wrong answer', () => {
  const { solve, broken, brief } = require('../puzzles');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'study3-home-'));
  const fake3 = ['sh', '-c', `case "$1" in
  *"Why did they go wrong"*) printf 'KIND: MISSED | never used (b)\\n';;
  *"just finished"*) printf 'AFTER\\n';;
  *"code puzzle"*|*"-digit code"*) printf 'INSERT AFTER 0\\nANSWER: 1 2\\nEND\\nSAY: fix line 1\\nSTATUS: done\\n';;
  *) printf 'SAY: line 1 is short\\nINSERT AFTER 0\\nflour flour\\nEND\\nSTATUS: done\\n';;
esac`, 'x', '{prompt}'];
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [{ id: 'a', label: 'Agent', headless: fake3 }] }));
  const puzzle = { size: 2, code: '34', clues: [
    { type: 'sum', total: 7, say: 'The digits add up to 7.' },
    { type: 'diff', i: 1, j: 0, k: 1, say: 'The second digit is 1 more than the first.' }] };
  expect(solve(puzzle.clues, 2)).toEqual(['34']);
  expect(broken(puzzle.clues, '1 2', 2).map(c => c.type)).toEqual(['sum']);
  expect(brief(puzzle)).toContain('(b) The second digit is 1 more');
  const file = path.join(home, 's.json');
  fs.writeFileSync(file, JSON.stringify({ title: 'T3', agents: ['a#1', 'a#2'], judges: ['a'], room: { moves: 2, min_moves: 0, self_review: true },
    repeats: 2, tasks: [
      { id: 'bake', kind: 'poem', brief: 'a poem', judge: false, checker: true, roles: ['WRITE', 'CHECK'],
        checks: [{ say: 'Says flour twice.', type: 'contains', word: 'flour', min: 2 }, { say: 'Eight lines.', type: 'lines', min: 8, max: 8 }] },
      { id: 'code', judge: false, puzzle }] }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'study.js'), file],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  const dir = out.match(/Study folder: (.+)/)[1].trim();
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'study.json'), 'utf8'));
  const [bake, code] = s.tasks;
  expect(Object.keys(bake.repeats[0].runs)).toEqual(['a-1 alone', 'a-2 alone', 'together', 'writer + checker']);
  // Two agents of one model: told apart by number, and not called "other labs".
  const tp = fs.readFileSync(path.join(bake.repeats[0].runs.together.dir, 'steps', '01-a-1.prompt.md'), 'utf8');
  expect(tp).toContain('You are Agent 1. You and Agent 2, AI agents, are');
  // The checker's edits are refused; it rotates to the other agent on repeat 2.
  const wc = JSON.parse(fs.readFileSync(path.join(bake.repeats[0].runs['writer + checker'].dir, 'timeline.json'), 'utf8'));
  const byB = wc.moves.filter(m => m.agent === 'a-2');
  expect(byB.length).toBeGreaterThan(0);
  expect(byB.every(m => !m.landed.length && m.dropped.every(d => /check, not to edit/.test(d.why)))).toBe(true);
  expect(wc.final.every(l => l.by !== 'a-2')).toBe(true);
  expect(bake.repeats[1].roles).toEqual({ 'a-2': 'WRITE', 'a-1': 'CHECK' });
  // Self review: a solo "done" first gets a review move.
  const solo = bake.repeats[0].runs['a-1 alone'].dir;
  expect(fs.readFileSync(path.join(solo, 'steps', '02-a-1.prompt.md'), 'utf8')).toContain('Review pass');
  expect(bake.checks['writer + checker']).toEqual({ mean: 1, of: 2, all: 0, runs: 2 });
  // The puzzle: wrong answers are diagnosed, and the summary counts them.
  const p = code.repeats[0].runs.together.puzzle;
  expect(p).toMatchObject({ answer: '1 2', right: false, broke: ['The digits add up to 7.'], why: { kind: 'missed' } });
  expect(code.puzzle.together).toEqual({ right: 0, runs: 2, why: { missed: 2 } });
  const md = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8');
  expect(md).toContain('- together: right 0/2 (wrong: 2 missed)');
  expect(md).toContain('- writer + checker: checks 1/2 on average, all passed in 0/2');
});

test('scaling curve: 1 to 3 copies of one model on a bank of puzzles, scored by right answers', () => {
  const { bankBrief, bankChecks } = require('../puzzles');
  const { check, makeDoc } = require('../room');
  const bank = [{ size: 2, code: '34', clues: [{ type: 'sum', total: 7, say: 'Sum 7.' }] }, { size: 2, code: '11', clues: [{ type: 'sum', total: 2, say: 'Sum 2.' }] }];
  expect(bankBrief(bank)).toContain('Puzzle 2 (2 digits, each 0 to 9): (a) Sum 2.');
  const [c1, c2] = bankChecks(bank);
  expect(check(c1, makeDoc(['ANSWER 1: 3 4', 'ANSWER 2: 99']).lines)).toBe(true);
  expect(check(c2, makeDoc(['ANSWER 1: 3 4', 'ANSWER 2: 99']).lines)).toBe(false);
  expect(check(c2, makeDoc(['ANSWER 2: 99', 'ANSWER 2: 1 1']).lines)).toBe(true);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-home-'));
  const fk = ['sh', '-c', `case "$1" in *"just finished"*) printf 'ok\\n';; *) printf 'INSERT AFTER 0\\nANSWER 1: 34\\nEND\\nSTATUS: done\\n';; esac`, 'x', '{prompt}'];
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [{ id: 'a', label: 'Agent', headless: fk }] }));
  const file = path.join(home, 's.json');
  fs.writeFileSync(file, JSON.stringify({ title: 'Scale', agents: ['a'], scale: { agent: 'a', sizes: [1, 3] }, room: { moves: 1, min_moves: 0, turns: false },
    repeats: 2, tasks: [{ id: 'bank', judge: false, bank }] }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'study.js'), file],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  const dir = out.match(/Study folder: (.+)/)[1].trim();
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'study.json'), 'utf8'));
  const t = s.tasks[0];
  expect(Object.keys(t.repeats[0].runs)).toEqual(['1 a alone', '3 a copies']);
  const tl = JSON.parse(fs.readFileSync(path.join(t.repeats[0].runs['3 a copies'].dir, 'timeline.json'), 'utf8'));
  expect(tl.agents.map(a => a.id)).toEqual(['a-1', 'a-2', 'a-3']);
  expect(t.checks['1 a alone']).toMatchObject({ mean: 1, of: 2, all: 0, runs: 2 });
  expect(fs.readFileSync(path.join(dir, 'summary.md'), 'utf8')).toContain('- 3 a copies: right 1/2 on average, all right in 0/2');
});

test('interventions: one team under each variant, with process labels from judges who never see the names', () => {
  const { parseProcess } = require('../study');
  expect(parseProcess('**CHANGED**: 2 | b cut its line\nCAUGHT: 1\nPASSED: 0 | none\nBUILT: 3')).toEqual({
    changed: { n: 2, example: 'b cut its line' }, caught: { n: 1, example: '' }, passed: { n: 0, example: 'none' }, built: { n: 3, example: '' } });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'study5-home-'));
  const fk = ['sh', '-c', `case "$1" in
  *"Score each from 1 to 10"*) printf 'A: 5\\nB: 6\\nC: 7\\nBEST: C\\n';;
  *"Count, from the record only"*) printf 'CHANGED: 1 | x\\nCAUGHT: 2\\nPASSED: 0\\nBUILT: 4\\n';;
  *"just finished"*) printf 'ok\\n';;
  *) printf 'SAY: ok?\\nPLAN: do it\\nAGREE: yes\\nINSERT AFTER 0\\nflour flour\\nEND\\nSTATUS: done\\n';;
esac`, 'x', '{prompt}'];
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [{ id: 'a', label: 'Agent Model', headless: fk }] }));
  const file = path.join(home, 's.json');
  fs.writeFileSync(file, JSON.stringify({ title: 'T5', agents: ['a#1', 'a#2'], judges: ['a'], process_judges: ['a'], solo: ['a'],
    room: { moves: 2, min_moves: 0, turns: true }, repeats: 2,
    variants: [{ label: 'silent', room: { silent: true } }, { label: 'plan first', room: { plan_first: true, silent: false } },
      { label: 'checker', roles: ['WRITE', 'CHECK'], checker: true, only: ['other'] }],
    tasks: [{ id: 'bake', kind: 'poem', brief: 'a poem', checks: [{ say: 'Says flour twice.', type: 'contains', word: 'flour', min: 2 }] }] }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'study.js'), file],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  const dir = out.match(/Study folder: (.+)/)[1].trim();
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'study.json'), 'utf8'));
  const t = s.tasks[0];
  expect(Object.keys(t.repeats[0].runs)).toEqual(['a alone', 'silent', 'plan first']); // "checker" is only for task "other"
  expect(t.repeats[0].runs['plan first'].stats.planAgreedAt).toBe(2);
  // Who moves first rotates.
  const tl2 = JSON.parse(fs.readFileSync(path.join(t.repeats[1].runs.silent.dir, 'timeline.json'), 'utf8'));
  expect(tl2.moves[0].agent).toBe('a-2');
  // The process judge saw no names.
  const pp = fs.readFileSync(path.join(dir, 'steps', 'process-bake-1-plan-first-a.prompt.md'), 'utf8');
  expect(pp).toContain('--- move 1, Agent 1 ---');
  expect(pp).not.toMatch(/Agent Model|a-1|a-2/);
  expect(t.process['plan first']).toMatchObject({ changed: 1, caught: 2, passed: 0, built: 4, questions: 4 });
  expect(t.process['a alone']).toBeNull();
  const md = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8');
  expect(md).toContain('- plan first: changed 1 · caught 2 · passed 0 · built 4 · questions 4');
});
