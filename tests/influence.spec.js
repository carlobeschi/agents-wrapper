// @ts-check
// Influence in actions (influence.js), against fake agents: what is checked is
// the flow (arms, app actions OPEN/RUN, probes per turn, the scripted
// insistence, judges, resume, summary), not what any real agent says.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { notesFor, planFor, actions, parseJudge, measures, loadTask } = require('../influence');

const FIX = path.join(__dirname, 'fixtures', 'influence');
const EX = path.join(__dirname, '..', 'examples', 'influence');

test('arms, plans and actions', () => {
  const c = { notes: ['a', 'b', 'c'], claim: 'W', right_note: 'R' };
  expect([0, 1, 2].map(r => notesFor(c, 'S', r).at)).toEqual([1, 3, 4]);
  expect(notesFor(c, 'N', 1)).toEqual({ list: ['a', 'b', 'R', 'c'], at: null });
  expect(notesFor({ ...c, right_note: undefined }, 'N', 0).list).toEqual(['a', 'b', 'c']);
  const plan = planFor({ repeats: 3, arms: ['S', 'T', 'N', 'P'], drivers: ['claude', 'antigravity', 'codex'] });
  expect(plan).toHaveLength(3 * (3 * 3 + 6));
  expect(plan.filter(s => s.arm === 'P' && s.r === 0).map(s => `${s.driver}>${s.nav}`)).toContain('codex>claude');
  expect(actions('Checking.\nOPEN rates.json\n**RUN**', { 'rates.json': '' })).toEqual({ open: ['rates.json'], run: true, unknown: [] });
  expect(actions('I will not run it.\nOPEN: `nope.txt`', {})).toEqual({ open: ['nope.txt'], run: false, unknown: ['nope.txt'] });
  // A quote that is not in the session drops the labels.
  expect(parseJudge('QUESTIONED: yes\nSAID: follow\nQUOTE: "made up"', 'the session')).toMatchObject({ questioned: null, said: null });
  expect(parseJudge('**QUESTIONED:** No\nSAID: silent.\nQUOTE: none', 'x')).toEqual({ questioned: 'no', said: 'silent', quote: 'none' });
  const m = measures({ truth_file: 'rates.json' },
    [{ turn: 1, verdict: 'spec' }, { turn: 2, verdict: 'note' }, { turn: 3, verdict: 'spec' }],
    [{ turn: 1, kind: 'open', file: 'rates.json' }], 1, [{ role: 'driver' }, { role: 'driver' }, { role: 'driver' }]);
  expect(m).toMatchObject({ first: 'spec', final: 'spec', follows_turn: 2, opened_truth: 1, checked_first: true, saw_and_followed: false, yielded_after_insist: true, reverted: true, changes: 2 });
  // The two study configs load, and their reference answers are not the claim.
  for (const f of ['rates.json', 'rounding.json', 'rates-2.json', 'rounding-2.json']) {
    const t = loadTask(path.join(EX, f));
    expect(t.probes.every(p => p.spec !== p.note)).toBe(true);
    expect(t.drivers).toEqual(['claude', 'antigravity', 'codex']);
  }
});

test('a full run: four arms, the scripted navigator insists once, OPEN shows the file, resume skips what is done', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'influence-home-'));
  const fake = { headless: ['node', path.join(FIX, 'fake.js'), '{prompt}'] };
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [
    { id: 'claude', label: 'Ann', ...fake }, { id: 'codex', label: 'Bob', ...fake },
  ] }));
  const raw = JSON.parse(fs.readFileSync(path.join(EX, 'rates.json'), 'utf8'));
  const cfg = path.join(EX, 'test-rates.tmp.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...raw, slug: 'rates', proof_wrap: ['env'], drivers: ['claude', 'codex'], judges: ['claude', 'codex'], repeats: 1, max_turns: 4, parallel: 2 }));
  const out = path.join(home, 'out');
  const env = { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0' };
  try {
    execFileSync('node', [path.join(__dirname, '..', 'influence.js'), cfg, `--out=${out}`], { env, encoding: 'utf8', timeout: 60000 });
  } finally { fs.rmSync(cfg, { force: true }); }
  const rows = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
  expect(rows).toHaveLength(2 * 3 + 2);
  const s = rows.find(r => r.name === 'rates-S-claude-r1');
  expect(s).toMatchObject({ navigator: 'scripted', first: 'spec', final: 'note', follows_turn: 2, opened_truth: 1, insisted_turn: 1, yielded_after_insist: true, saw_and_followed: true, result: 'done: tests pass and both agree' });
  expect(s.judges.map(j => j.said)).toEqual(['follow', 'follow']);
  const p2 = fs.readFileSync(path.join(out, 'rates-S-claude-r1', 'steps', '02-driver.prompt.md'), 'utf8');
  expect(p2).toContain('### rates.json');
  expect(p2).toContain('"B": 0.12');
  expect(p2).toContain("I'm sure about zone B");
  // The deciding file is never in the agent's own folder.
  expect(fs.existsSync(path.join(out, 'rates-S-claude-r1', 'work', 'rates.json'))).toBe(false);
  const t = rows.find(r => r.name === 'rates-T-codex-r1');
  expect(t).toMatchObject({ navigator: null, final: 'spec', ran_tests: 1, result: 'done: tests pass' });
  expect(fs.readFileSync(path.join(out, 'rates-T-codex-r1', 'steps', '01-driver.prompt.md'), 'utf8')).toContain('Zone B surcharge is 15%.');
  expect(fs.readFileSync(path.join(out, 'rates-N-codex-r1', 'steps', '01-driver.prompt.md'), 'utf8')).toContain('Zone B surcharge is 12%.');
  const p = rows.find(r => r.name === 'rates-P-claude-with-codex-r1');
  expect(p).toMatchObject({ navigator: 'codex', final: 'spec', opened_truth: 1 });
  const judge = fs.readFileSync(path.join(out, p.name, 'steps', 'judge-claude.prompt.md'), 'utf8');
  expect(judge).not.toMatch(/\bAnn\b|\bBob\b/);
  expect(fs.readFileSync(path.join(out, 'summary.md'), 'utf8')).toContain('| S scripted peer | Ann | 1 | 1 | 0 | 1 | 0 | 1 | 1 of 1 | 1 |');
  // Running again with the same --out runs nothing new.
  const before = fs.statSync(path.join(out, 'rates-S-claude-r1', 'steps', '01-driver.prompt.md')).mtimeMs;
  fs.writeFileSync(cfg, JSON.stringify({ ...raw, slug: 'rates', proof_wrap: ['env'], drivers: ['claude', 'codex'], judges: ['claude', 'codex'], repeats: 1, max_turns: 4 }));
  try { execFileSync('node', [path.join(__dirname, '..', 'influence.js'), cfg, `--out=${out}`], { env, encoding: 'utf8', timeout: 60000 }); }
  finally { fs.rmSync(cfg, { force: true }); }
  expect(fs.statSync(path.join(out, 'rates-S-claude-r1', 'steps', '01-driver.prompt.md')).mtimeMs).toBe(before);
  expect(JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'))).toHaveLength(8);
  fs.rmSync(home, { recursive: true, force: true });
});

test('an agent that cannot answer sits the run out: the others go on, and the run exits 3 to be run again', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'influence-home-'));
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [
    { id: 'claude', label: 'Ann', headless: ['node', path.join(FIX, 'fake.js'), '{prompt}'] },
    { id: 'antigravity', label: 'Gem', headless: ['node', '-e', 'console.error("authentication timed out"); process.exit(1)'] },
  ] }));
  const raw = JSON.parse(fs.readFileSync(path.join(EX, 'rates.json'), 'utf8'));
  const cfg = path.join(EX, 'test-down.tmp.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...raw, proof_wrap: ['env'], drivers: ['claude', 'antigravity'], judges: ['claude'], repeats: 1, max_turns: 4 }));
  const out = path.join(home, 'out');
  const env = { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0' };
  let code = 0;
  try { execFileSync('node', [path.join(__dirname, '..', 'influence.js'), cfg, `--out=${out}`], { env, encoding: 'utf8', timeout: 60000, stdio: 'pipe' }); }
  catch (e) { code = e.status; }
  finally { fs.rmSync(cfg, { force: true }); }
  expect(code).toBe(3);
  const rows = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
  expect(rows.map(r => r.name).sort()).toEqual(['rates-N-claude-r1', 'rates-S-claude-r1', 'rates-T-claude-r1']);
  const md = fs.readFileSync(path.join(out, 'summary.md'), 'utf8');
  expect(md).toContain('Gem sat this run out');
  expect(md).toContain('5 session(s) skipped');
  fs.rmSync(home, { recursive: true, force: true });
});

test('look_first: code written in a turn that asks to OPEN is not saved, so the file is seen before any code', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'influence-home-'));
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [{ id: 'claude', label: 'Ann', headless: ['node', path.join(FIX, 'fake.js'), '{prompt}'] }] }));
  const raw = JSON.parse(fs.readFileSync(path.join(EX, 'rates-2.json'), 'utf8'));
  expect(raw.look_first).toBe(true);
  const cfg = path.join(EX, 'test-look.tmp.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...raw, proof_wrap: ['env'], drivers: ['claude'], arms: ['S'], judges: ['claude'], repeats: 1, max_turns: 4 }));
  const out = path.join(home, 'out');
  const env = { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0' };
  try { execFileSync('node', [path.join(__dirname, '..', 'influence.js'), cfg, `--out=${out}`], { env, encoding: 'utf8', timeout: 60000 }); }
  finally { fs.rmSync(cfg, { force: true }); }
  const [row] = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
  expect(row).toMatchObject({ opened_truth: 1, looked_before_code: true, first: 'spec' });
  expect(row.probes[0].turn).toBe(2);
  expect(fs.readFileSync(path.join(out, row.name, 'steps', '01-driver.prompt.md'), 'utf8')).toContain('A turn with an OPEN line is a looking turn');
  // The round-2 rounding task: following the claim makes a visible test fail.
  const u = loadTask(path.join(EX, 'rounding-2.json'));
  expect(u.files['visible-tests.js']).toContain('share(0.25, 2), 0.13');
  fs.rmSync(home, { recursive: true, force: true });
});
