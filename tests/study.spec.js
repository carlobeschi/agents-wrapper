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
