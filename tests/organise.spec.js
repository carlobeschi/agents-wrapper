// @ts-check
// The agents choose how to work together (organise.js): specs are read and
// checked against the budget, and a whole ladder runs with fake agents.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseSpecs, validate, describe, taskFor } = require('../organise');

const B = { moves: 16, calls: 20, minutes: 5, max_agents: 4, max_steps: 8 };

test('specs are read from a reply and checked against the budget', () => {
  const fork = { name: 'fork', prediction: 70, steps: [
    { id: 'a', do: 'work', agents: 1, moves: 4, talk: false },
    { id: 'b', do: 'work', agents: 1, moves: 4, from: 'a' }, { id: 'c', do: 'work', agents: 1, moves: 4, from: 'a' },
    { id: 'r', do: 'review', from: 'b' }, { id: 'p', do: 'pick', from: ['b', 'c'] }, { id: 'm', do: 'merge', from: ['b', 'c'], moves: 2 }], final: 'm' };
  expect(parseSpecs('Here:\n```json\n' + JSON.stringify(fork) + '\n```')).toHaveLength(1);
  expect(parseSpecs('```json\n[' + JSON.stringify(fork) + ',' + JSON.stringify(fork) + ']\n```')).toHaveLength(2);
  expect(parseSpecs('no json here')).toEqual([]);
  expect(validate(fork, B)).toEqual({ ok: true, errors: [], cost: { moves: 14, calls: 16 } });
  const bad = { steps: [{ id: 'a', do: 'work', agents: 5, moves: 20 }, { id: 'a', do: 'dance' }, { id: 'p', do: 'pick', from: ['a'] }, { id: 'r', do: 'review', from: 'zz' }], final: 'q' };
  const v = validate(bad, B);
  expect(v.ok).toBe(false);
  expect(v.errors.join('\n')).toMatch(/agents" must be 1 to 4/);
  expect(v.errors.join('\n')).toMatch(/used twice/);
  expect(v.errors.join('\n')).toMatch(/"do" must be/);
  expect(v.errors.join('\n')).toMatch(/at least 2 earlier steps/);
  expect(v.errors.join('\n')).toMatch(/"zz", which is not an earlier step/);
  expect(v.errors.join('\n')).toMatch(/"final" names "q"/);
  expect(validate({ steps: [{ id: 'a', do: 'work', agents: 4, moves: 5 }] }, B).errors.join(' ')).toMatch(/20 moves; the budget is 16/);
  expect(validate({ steps: [{ id: 'a', do: 'work', agents: 1, moves: 2 }, { id: 'r', do: 'review', from: 'a' }], final: 'r' }, B).errors.join(' ')).toMatch(/not a review/);
  expect(describe(fork)).toBe('a: 1 agent, 4 moves each → b: 1 agent, 4 moves each, from a → c: 1 agent, 4 moves each, from a → r: review of b → p: pick the best of b, c → m: merge b, c in 2 moves');
  const t1 = taskFor({ id: 'bank', bank: { count: 3, size: 4 } }, 1), t1b = taskFor({ id: 'bank', bank: { count: 3, size: 4 } }, 1), t2 = taskFor({ id: 'bank', bank: { count: 3, size: 4 } }, 2);
  expect(t1.checks).toHaveLength(3);
  expect(t1.brief).toBe(t1b.brief); // the same bank for every rung of one repeat
  expect(t1.brief).not.toBe(t2.brief);
});

test('a ladder runs: solo, ours, the proposer\'s choice, and a research round with a report', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'organise-home-'));
  const spec = n => ({ name: `org ${n}`, why: 'test', prediction: 50 + n, steps: [{ id: 'a', do: 'work', agents: 1, moves: 1 }, { id: 'b', do: 'work', agents: 1, moves: 1, from: 'a' },
    { id: 'r', do: 'review', from: 'a' }, { id: 'c', do: 'work', agents: 2, moves: 1, from: 'a', notes_from: 'r', talk: true }, { id: 'p', do: 'pick', from: ['b', 'c'] }], final: 'p' });
  fs.writeFileSync(path.join(home, 'one.json'), '```json\n' + JSON.stringify(spec(1)) + '\n```');
  fs.writeFileSync(path.join(home, 'three.json'), '```json\n' + JSON.stringify([spec(1), spec(2), spec(3)]) + '\n```');
  fs.writeFileSync(path.join(home, 'report.txt'), 'FOUND: forks did nothing.\nNEXT:\n```json\n' + JSON.stringify(spec(9)) + '\n```');
  const fk = ['sh', '-c', `case "$1" in
  *"Propose 3 organisations"*) cat "${home}/three.json";;
  *"Write what you found"*) cat "${home}/report.txt";;
  *"Choose the organisation"*) cat "${home}/one.json";;
  *"Review this draft"*) printf '1. add flour\\n';;
  *"BEST: <letter>"*) printf 'BEST: B\\n';;
  *"SCORE: <number>"*) printf 'SCORE: 6 | fine\\n';;
  *"just finished"*) printf 'ok\\n';;
  *"label it against"*) printf '#1 | HUMAN: close | ANALOGUE: x | SAME AS: none | CHEAP: yes | WHY: w\\n';;
  *) printf 'INSERT AFTER 0\\nflour\\nEND\\nSTATUS: done\\n';;
esac`, 'x', '{prompt}'];
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [{ id: 'w', label: 'W', headless: fk }, { id: 'p', label: 'P', headless: fk }, { id: 'j', label: 'J', headless: fk }] }));
  fs.writeFileSync(path.join(home, 'ideate.json'), JSON.stringify({ tried: [{ id: 'T1', text: 'debate' }], catalogue: [{ id: 'M1', text: 'fork' }] }));
  const file = path.join(home, 'o.json');
  fs.writeFileSync(file, JSON.stringify({ title: 'O', worker: 'w', proposers: ['p'], judges: ['p', 'j'], repeats: 1, label_with: 'ideate.json',
    budget: { moves: 8, calls: 12, minutes: 3 }, room: { lines_per_move: 4 },
    tasks: [{ id: 'bake', kind: 'poem', brief: 'a poem', short: 'a poem about flour', checks: [{ say: 'Says flour.', type: 'contains', word: 'flour' }, { say: 'Two lines.', type: 'lines', min: 2, max: 2 }],
      l0: { name: 'ours', steps: [{ id: 'a', do: 'work', agents: 2, moves: 2, talk: true }], final: 'a' } }] }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'organise.js'), file],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  const dir = out.match(/Organise: (.+)/)[1].trim();
  const runs = JSON.parse(fs.readFileSync(path.join(dir, 'runs.json'), 'utf8'));
  expect(runs.map(r => r.key)).toEqual(['bake-r1-solo', 'bake-r1-L0', 'bake-r1-L1-p', 'bake-r1-L3-p-r1-1', 'bake-r1-L3-p-r1-2', 'bake-r1-L3-p-r1-3', 'bake-r1-L3-p-r2']);
  expect(runs.every(r => !r.error)).toBe(true);
  const l1 = runs.find(r => r.level === 'L1');
  expect(l1.steps.map(s => s.do)).toEqual(['work', 'work', 'review', 'work', 'pick']);
  expect(l1.checks).toBe(50); // "flour" passes, two lines fails
  expect(l1.quality).toEqual({ j: 6 }); // the proposer never judges its own organisation
  expect(l1.score).toBe(55);
  expect(runs.find(r => r.key.endsWith('-r2'))).toMatchObject({ round: 2, found: 'forks did nothing.', spec: { name: 'org 9' } });
  // The review reached the next step's agents as a note.
  const room = JSON.parse(fs.readFileSync(path.join(l1.steps[3].dir, 'room.json'), 'utf8'));
  expect(Object.values(room.secrets)[0]).toContain('add flour');
  expect(room.agents).toEqual(['w#3', 'w#4']);
  const md = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8');
  expect(md).toContain('| L1 | p | 55 (n=1) | 1 |');
  expect(md).toContain('human-like: close');
  expect(md).toContain('**p found (bake):** forks did nothing.');
  expect(md).toMatch(/Prediction minus score/);
  expect(fs.readFileSync(path.join(dir, 'steps', 'report-bake-r1-L3-p.prompt.md'), 'utf8')).toContain('one agent alone (ours, for comparison)');
});

test('kata: what changed between rounds, and what happened after a drop', () => {
  const { specChanges, coreChanges, afterDrop } = require('../organise');
  const a = { steps: [{ id: 'a', do: 'work', agents: 2, moves: 4, talk: true }], final: 'a' };
  const b = { steps: [{ id: 'a', do: 'work', agents: 4, moves: 2, talk: true, turns: true }], final: 'a' };
  expect(specChanges(a, b)).toEqual(['a.agents', 'a.moves']); // turns: true is the default
  expect(coreChanges(specChanges(a, b))).toEqual(['a.agents']); // moves adjusted to fit the budget do not count
  const c = { steps: [{ id: 'a', do: 'work', agents: 2, moves: 4, talk: false, versions: true }, { id: 'r', do: 'review', from: 'a' }], final: 'r' };
  expect(specChanges(a, c)).toEqual(['+step r', 'a.talk', 'a.versions', 'final']);
  expect(coreChanges(specChanges(a, c))).toEqual(['+step r', 'a.talk', 'a.versions']);
  expect(specChanges(a, a)).toEqual([]);
  const row = (spec, score) => ({ spec, score });
  expect(afterDrop(row(a, 60), row(b, 40), row(a, 50))).toBe('undone');
  expect(afterDrop(row(a, 60), row(b, 40), row(b, 50))).toBe('kept');
  expect(afterDrop(row(a, 60), row(b, 55), row(b, 50))).toBe(null); // not a drop
  expect(afterDrop(row(a, 60), row(c, 30), row({ steps: [{ id: 'a', do: 'work', agents: 2, moves: 4, talk: false, versions: true }], final: 'a' }, 50))).toBe('undone');
});

test('kata: a fixed arm, a free arm, a kata arm and a coached arm run round by round', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'organise-kata-'));
  const one = { name: 'one agent', prediction: 70, steps: [{ id: 'a', do: 'work', agents: 1, moves: 2 }], final: 'a' };
  fs.writeFileSync(path.join(home, 'kata.txt'), 'TARGET: 90\nLEARNED: two was noisy\nOBSTACLE: clashes\nCHANGE: agents 2 to 1\n```json\n' + JSON.stringify(one) + '\n```');
  fs.writeFileSync(path.join(home, 'after.txt'), 'ANSWERS: yes, one change\nTARGET: 80\nLEARNED: after coach\nOBSTACLE: clashes\nCHANGE: agents\n```json\n' + JSON.stringify(one) + '\n```');
  const fk = ['sh', '-c', `case "$1" in
  *"A coach read your draft"*) cat "${home}/after.txt";;
  *"You are a coach"*) printf 'QUESTIONS:\\nIs it one change?\\nWhy 70?\\n';;
  *"round by round"*) cat "${home}/kata.txt";;
  *"just finished"*) printf 'ok\\n';;
  *) printf 'INSERT AFTER 0\\nflour\\nEND\\nSTATUS: done\\n';;
esac`, 'x', '{prompt}'];
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: ['w', 'p', 'q'].map(id => ({ id, label: id.toUpperCase(), headless: fk })) }));
  const file = path.join(home, 'k.json');
  fs.writeFileSync(file, JSON.stringify({ title: 'K', worker: 'w', proposers: ['p', 'q'], judges: ['p'], repeats: 1, levels: ['kata'], kata: { rounds: 3 },
    budget: { moves: 8, calls: 12, minutes: 3 }, room: { lines_per_move: 4 },
    tasks: [{ id: 'bake', kind: 'poem', judge: false, brief: 'a poem', short: 'a poem about flour', checks: [{ say: 'Says flour.', type: 'contains', word: 'flour' }, { say: 'Two lines.', type: 'lines', min: 2, max: 2 }],
      l0: { name: 'ours', steps: [{ id: 'a', do: 'work', agents: 2, moves: 2, talk: true }], final: 'a' } }] }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'organise.js'), file],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  const dir = out.match(/Organise: (.+)/)[1].trim();
  const runs = JSON.parse(fs.readFileSync(path.join(dir, 'runs.json'), 'utf8'));
  expect(runs.filter(r => r.arm === 'fixed').map(r => r.round)).toEqual([1, 2, 3]);
  expect(runs.filter(r => r.arm !== 'fixed').map(r => r.key)).toEqual([
    'bake-r1-kata-free-p-k2', 'bake-r1-kata-free-p-k3', 'bake-r1-kata-kata-p-k2', 'bake-r1-kata-kata-p-k3', 'bake-r1-kata-coach-p-k2', 'bake-r1-kata-coach-p-k3',
    'bake-r1-kata-free-q-k2', 'bake-r1-kata-free-q-k3', 'bake-r1-kata-kata-q-k2', 'bake-r1-kata-kata-q-k3', 'bake-r1-kata-coach-q-k2', 'bake-r1-kata-coach-q-k3']);
  expect(runs.every(r => !r.error)).toBe(true);
  const k2 = runs.find(r => r.key === 'bake-r1-kata-kata-p-k2'), k3 = runs.find(r => r.key === 'bake-r1-kata-kata-p-k3');
  expect(k2).toMatchObject({ target: 90, learned: 'two was noisy', obstacle: 'clashes', changes: ['a.agents', 'a.talk'], checks: 50 });
  expect(k3.changes).toEqual([]); // the same organisation again
  expect(runs.find(r => r.key === 'bake-r1-kata-free-p-k2').target).toBe(null); // the free arm sets no target
  const coached = runs.find(r => r.key === 'bake-r1-kata-coach-p-k2');
  expect(coached).toMatchObject({ coach: 'q', target: 80, answers: 'yes, one change', questions: 'Is it one change?\nWhy 70?' });
  expect(runs.find(r => r.key === 'bake-r1-kata-coach-q-k2').coach).toBe('p'); // the coach is the other proposer
  const k3prompt = fs.readFileSync(path.join(dir, 'steps', 'kata-bake-r1-kata-kata-p-k3.prompt.md'), 'utf8');
  expect(k3prompt).toContain('Round 1 (the starting point, our design)');
  expect(k3prompt).toContain('You expected 70, it scored 50');
  expect(k3prompt).toContain('Your target for round 3: 90.');
  expect(k3prompt).not.toContain('TARGET:');
  const md = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8');
  expect(md).toContain('## Kata');
  expect(md).toContain('| fixed | - | 50 | 50 | 50 | 1 |');
  expect(md).toMatch(/kata · p · repeat 1: r1 50 → r2 50 \(70\) \[2 changes\] → r3 50 \(70\) \[0 changes\] · target 90/);
  expect(md).not.toContain('| solo |');
});
