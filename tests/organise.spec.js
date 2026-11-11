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
