// @ts-check
// bench.js against fake agents: rows become study.js variants, the wrong-note
// column runs through wrongnote.js, every cell is a JSON file, a second run only
// fills what is missing, and the report keeps rows in order with gains and intervals.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('interval: the mean of task means, with a seeded resample', () => {
  const { interval } = require('../bench');
  expect(interval([[1, 1, 1]])).toEqual({ mean: 1, lo: 1, hi: 1 });
  const x = interval([[0, 10, 20], [5]]);
  expect(x.mean).toBe(7.5);
  expect(x.lo).toBeLessThanOrEqual(7.5);
  expect(x.hi).toBeGreaterThanOrEqual(7.5);
  expect(interval([[3]])).toEqual({ mean: 3, lo: null, hi: null });
});

test('a small bench: cells per row and repeat, resumable, and a report in fixed row order', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-home-'));
  const fake = ['node', path.join(__dirname, 'fixtures', 'bench-fake.js'), '{prompt}'];
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [{ id: 'a', label: 'A', headless: fake }, { id: 'g', label: 'G', headless: fake }] }));
  const wn = path.join(home, 'wn.json');
  fs.writeFileSync(wn, JSON.stringify({ spec: 'Left to right.', nav_task: 'A calculator.', notes: ['N1'], wrong_note: 'Right to left.', conflict: 'Left to right.',
    probes: [{ expr: '10 - 4 - 1', spec: 5, note: 7 }], tests: path.join(__dirname, 'fixtures', 'wrongnote', 'hidden'), proof: ['node', 'hidden-tests/ok.js'], proof_wrap: ['env'],
    judges: ['a'], max_turns: 4 }));
  const file = path.join(home, 'tiny.json');
  fs.writeFileSync(file, JSON.stringify({ title: 'Tiny bench', judges: ['a', 'g'], process_judges: ['a'], team: ['a#1', 'a#2'], solo: 'a', repeats: 2,
    room: { moves: 2, min_moves: 0, turns: true, silent: false },
    rows: [
      { id: 'solo', label: 'Alone', solo: true, wrongnote: { solo: ['a'] } },
      { id: 'pair', label: 'Pair', variant: { room: {} }, wrongnote: { pairs: [['a#1', 'a#2']] } },
      { id: 'mixed', label: 'Mixed', variant: { agents: ['a', 'g'], room: {} }, skip: ['wrongnote'] },
      { id: 'best', label: 'Best of 2', variant: { tournament: { generate: ['a#1', 'a#2'], revise: false, rank: 'a' }, not_judged_by: ['a'] }, skip: ['wrongnote'] },
    ],
    tasks: [
      { id: 'poem', instances: [{ kind: 'poem', brief: 'a poem', checks: [{ say: 'Says flour twice.', type: 'contains', word: 'flour', min: 2 }] }] },
      { id: 'wrongnote', wrongnote: [wn] },
    ] }));
  const env = { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0' };
  const out = execFileSync('node', [path.join(__dirname, '..', 'bench.js'), file], { env, encoding: 'utf8', timeout: 60000 });
  const run = out.match(/Bench folder: (.+)/)[1].trim();
  const cell = (t, r, n) => JSON.parse(fs.readFileSync(path.join(run, 'cells', t, r, `r${n}.json`), 'utf8'));
  // Room cells: poem score = half rules, half judges; the mixed pair is its own team with shared moves.
  const solo = cell('poem', 'solo', 1);
  expect(solo).toMatchObject({ task: 'poem', config: 'solo', repeat: 1, starter: null });
  expect(Object.keys(solo.per_judge).sort()).toEqual(['a', 'g']);
  const mixed = cell('poem', 'mixed', 2);
  expect(mixed.models.sort()).toEqual(['a', 'g']);
  expect(mixed.starter).toBe('g'); // repeat 2 starts with the second agent
  expect(mixed.observations).toMatchObject({ changed: 1, built: 2, rules: '1/1' });
  expect(mixed.observations.quotes[0]).toContain('took the other line');
  // A row a judge played in is not scored by that judge.
  expect(Object.keys(cell('poem', 'best', 1).per_judge)).toEqual(['g']);
  expect(cell('poem', 'best', 1).observations.winner).toMatch(/^a-/);
  // The wrong-note column: one cell per row and repeat, from wrongnote.js.
  expect(cell('wrongnote', 'solo', 1)).toMatchObject({ score: 100, observations: { sessions: 1, final_follows_note: 0 } });
  expect(cell('wrongnote', 'pair', 2)).toMatchObject({ score: 100, observations: { sessions: 1, first_code_follows_note: 1, raised: 1 } });
  // The report: fixed row order, gains, the judges one by one.
  const md = fs.readFileSync(path.join(run, 'report.md'), 'utf8');
  expect(md.indexOf('| Pair |')).toBeLessThan(md.indexOf('| Mixed |'));
  expect(md).toContain('| Alone | 2 |');
  expect(md).toContain('## Every row over all tasks');
  expect(md).toContain('## By judge (mean score)');
  expect(md).toContain('From the transcripts:');
  // A second run runs nothing new.
  const again = execFileSync('node', [path.join(__dirname, '..', 'bench.js'), file], { env, encoding: 'utf8', timeout: 60000 });
  expect(again).toContain('poem repeat 1: done already');
  expect(again).not.toContain('Study folder');
  // Another runner's cells in the same shape join the table.
  fs.mkdirSync(path.join(run, 'cells', 'map', 'swarm-marks'), { recursive: true });
  fs.writeFileSync(path.join(run, 'cells', 'map', 'swarm-marks', 'r1.json'), JSON.stringify({ task: 'map', config: 'swarm-marks', repeat: 1, score: 80, calls: 60, observations: { marks_left: 12, quotes: [] } }));
  const rep = execFileSync('node', [path.join(__dirname, '..', 'bench.js'), file, '--report'], { env, encoding: 'utf8' });
  expect(rep).toContain('## map');
  expect(rep).toContain('| swarm-marks | 1 | 80 |');
  // Its own base row (swarm.js names Claude alone "solo-strong") gives the gain.
  fs.mkdirSync(path.join(run, 'cells', 'map', 'solo-strong'), { recursive: true });
  fs.writeFileSync(path.join(run, 'cells', 'map', 'solo-strong', 'r1.json'), JSON.stringify({ task: 'map', config: 'solo-strong', repeat: 1, score: 70, observations: {} }));
  expect(execFileSync('node', [path.join(__dirname, '..', 'bench.js'), file, '--report'], { env, encoding: 'utf8' })).toContain('| swarm-marks | 1 | 80 | 10 |');
});

test('a cell where a part never happened is broken: left out of the report and run again', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-broken-'));
  const fake = ['node', path.join(__dirname, 'fixtures', 'bench-fake.js'), '{prompt}'];
  // "g" fails every call, as an agent whose CLI is out of credit would.
  const dead = ['node', '-e', 'process.exit(1)'];
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [{ id: 'a', label: 'A', headless: fake }, { id: 'g', label: 'G', headless: dead }] }));
  const file = path.join(home, 'tiny.json');
  fs.writeFileSync(file, JSON.stringify({ title: 'Broken bench', judges: ['a', 'g'], process_judges: ['a'], team: ['a#1', 'a#2'], solo: 'a', repeats: 1,
    room: { moves: 2, min_moves: 0, turns: true, silent: false },
    rows: [
      { id: 'solo', label: 'Alone', solo: true },
      { id: 'mixed', label: 'Mixed', variant: { agents: ['a', 'g'], room: {} } },
    ],
    tasks: [{ id: 'poem', instances: [{ kind: 'poem', brief: 'a poem', checks: [{ say: 'Says flour twice.', type: 'contains', word: 'flour', min: 2 }] }] }] }));
  const env = { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0' };
  const out = execFileSync('node', [path.join(__dirname, '..', 'bench.js'), file], { env, encoding: 'utf8', timeout: 60000 });
  const run = out.match(/Bench folder: (.+)/)[1].trim();
  const cell = r => JSON.parse(fs.readFileSync(path.join(run, 'cells', 'poem', r, 'r1.json'), 'utf8'));
  expect(cell('mixed').broken).toEqual(expect.arrayContaining(['g never moved', expect.stringMatching(/^judge g gave no score/)]));
  expect(cell('solo').broken).toEqual([expect.stringMatching(/^judge g gave no score/)]);
  const md = fs.readFileSync(path.join(run, 'report.md'), 'utf8');
  expect(md).toContain('## Broken cells');
  expect(md).toContain('poem · Mixed · repeat 1: g never moved');
  expect(md).not.toContain('| Mixed |');
  // A cell written before this check (no "broken" field) is looked at again from its study.
  const f = path.join(run, 'cells', 'poem', 'mixed', 'r1.json');
  const { broken, ...old } = cell('mixed');
  // ...even when it was written on another computer (another home folder): the same path under this one's.
  old.source = path.join('/nowhere', '.agent-dispatch', path.relative(home, old.source));
  fs.writeFileSync(f, JSON.stringify(old));
  const rep = execFileSync('node', [path.join(__dirname, '..', 'bench.js'), file, '--report'], { env, encoding: 'utf8' });
  expect(rep).toContain('broken on a second look');
  expect(cell('mixed').broken).toContain('g never moved');
  // With "ping": true a model that doesn't answer stops the run before anything starts.
  const pinged = path.join(home, 'pinged.json');
  fs.writeFileSync(pinged, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ping: true }));
  let failed = null;
  try { execFileSync('node', [path.join(__dirname, '..', 'bench.js'), pinged], { env, encoding: 'utf8', stdio: 'pipe', timeout: 60000 }); } catch (e) { failed = e; }
  expect(failed?.status).toBe(3);
  expect(String(failed?.stderr)).toContain('- g:');
  // The next run does them again instead of keeping them.
  const again = execFileSync('node', [path.join(__dirname, '..', 'bench.js'), file], { env, encoding: 'utf8', timeout: 60000 });
  expect(again).not.toContain('done already');
});

test('wrong note: a session that errored runs again on its own, and the new one counts', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-wn-'));
  const fake = ['node', path.join(__dirname, 'fixtures', 'bench-fake.js'), '{prompt}'];
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [{ id: 'a', label: 'A', headless: fake }] }));
  const wn = path.join(home, 'wn.json');
  fs.writeFileSync(wn, JSON.stringify({ spec: 'Left to right.', nav_task: 'A calculator.', notes: ['N1'], wrong_note: 'Right to left.', conflict: 'Left to right.',
    probes: [{ expr: '10 - 4 - 1', spec: 5, note: 7 }], tests: path.join(__dirname, 'fixtures', 'wrongnote', 'hidden'), proof: ['node', 'hidden-tests/ok.js'], proof_wrap: ['env'],
    judges: ['a'], max_turns: 4 }));
  const file = path.join(home, 'wn-bench.json');
  fs.writeFileSync(file, JSON.stringify({ title: 'WN bench', judges: ['a'], team: ['a#1', 'a#2'], solo: 'a', repeats: 1, room: {},
    rows: [{ id: 'solo', label: 'Alone', solo: true, wrongnote: { solo: ['a'] } }, { id: 'pair', label: 'Pair', variant: {}, wrongnote: { pairs: [['a#1', 'a#2']] } }],
    tasks: [{ id: 'wrongnote', wrongnote: [wn] }] }));
  const env = { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0' };
  const bench = () => execFileSync('node', [path.join(__dirname, '..', 'bench.js'), file], { env, encoding: 'utf8', timeout: 60000 });
  const run = bench().match(/Bench folder: (.+)/)[1].trim();
  const res = path.join(run, 'wrongnote', 'wn', 'results.json');
  const rows = JSON.parse(fs.readFileSync(res, 'utf8'));
  const i = rows.findIndex(x => x.navigator);
  rows[i] = { ...rows[i], first: 'error', final: 'error', error: 'exit 1' };
  fs.writeFileSync(res, JSON.stringify(rows));
  bench();
  // Marked broken on the second look, then run again into a redo folder.
  const redo = fs.readdirSync(path.join(run, 'wrongnote')).filter(n => n.startsWith('wn-redo-'));
  expect(redo).toHaveLength(1);
  const again = JSON.parse(fs.readFileSync(path.join(run, 'wrongnote', redo[0], 'results.json'), 'utf8'));
  expect(again.map(x => x.name)).toEqual(['a-1-drives-a-2-r1']);
  const cell = JSON.parse(fs.readFileSync(path.join(run, 'cells', 'wrongnote', 'pair', 'r1.json'), 'utf8'));
  expect(cell.broken).toBeUndefined();
  expect(cell.score).toBe(100);
});
