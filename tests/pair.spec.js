// @ts-check
// The Pair (pair.js) against a fake Codex that streams JSONL events and a fake
// navigator: what is checked is the help pause, the cut-in, the resume of the
// same session, the hidden tests and the sign-off, not what any real agent says.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, HELP, END } = require('../pair');

const FIX = path.join(__dirname, 'fixtures', 'pair');

test('Codex events become readable timeline entries', () => {
  expect(describe({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test', aggregated_output: 'ok', exit_code: 0 } }))
    .toEqual({ kind: 'run', text: '$ npm test\nok', exit: 0, meaningful: true });
  expect(describe({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'a.js', kind: 'update' }] } }).text).toBe('update a.js');
  expect(describe({ type: 'turn.started' })).toBeNull();
  expect(describe({ type: 'item.completed', item: { type: 'web_search', query: 'x' } }).kind).toBe('web_search');
  expect(HELP.exec('Thinking.\nHELP: which file?')?.[1]).toBe('which file?');
  expect(END.test('Agreed.\nNext: end')).toBe(true);
});

test('a session: help, a cut-in, a resume of the same session, the hidden tests and sign-off', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-home-'));
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [
    { id: 'claude', label: 'Navi', headless: ['sh', path.join(FIX, 'nav.sh'), '{prompt}'] },
  ] }));
  const cfg = path.join(home, 'pair.json');
  fs.writeFileSync(cfg, JSON.stringify({
    task: 'Write 42 to answer.txt.', navigator_notes: 'SECRET-RULE: only the navigator knows.', tests: path.join(FIX, 'hidden'),
    proof: ['sh', '-c', 'test "$(cat answer.txt)" = 42 && test -f hidden-tests/check.txt'], proof_wrap: ['env'],
    look_secs: 999,
    driver: { model: '', start: ['node', path.join(FIX, 'fake-codex.js'), '-m', '{model}', '-'], resume: ['node', path.join(FIX, 'fake-codex.js'), 'resume', '{session}', '-'] },
  }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'pair.js'), cfg], {
    env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8', timeout: 25000,
  });
  expect(out).toContain('done: tests pass and both agree');
  const dir = path.join(home, 'pairs', fs.readdirSync(path.join(home, 'pairs'))[0]);
  const kinds = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8')).timeline.map(e => e.kind);
  expect(kinds).toEqual(['say', 'help', 'answer', 'edit', 'cut', 'edit', 'say', 'check', 'signoff']);
  const prompts = fs.readFileSync(path.join(dir, 'driver-prompts.txt'), 'utf8');
  expect(prompts.match(/^--- .*$/gm)).toEqual(['--- start', '--- resume th-123', '--- resume th-123']);
  expect(prompts).toContain('Navi answers your question:\n\nUse 42.');
  expect(prompts).toContain('Navi cuts in:\n\nThat says 41; the task wants 42.');
  // Requirements only the navigator knows: in its prompts, never in the driver's.
  expect(prompts).not.toContain('SECRET-RULE');
  expect(prompts).toContain('Navi knows requirements that are not in your task');
  const steps = fs.readdirSync(path.join(dir, 'steps')).filter(f => f.endsWith('.prompt.md'));
  expect(steps.length).toBeGreaterThan(0);
  for (const f of steps) expect(fs.readFileSync(path.join(dir, 'steps', f), 'utf8')).toContain('SECRET-RULE');
  // The hidden tests ran on a copy, never in the driver's folder.
  expect(fs.existsSync(path.join(dir, 'work', 'hidden-tests'))).toBe(false);
  const md = fs.readFileSync(path.join(dir, 'episode.md'), 'utf8');
  expect(md).toContain('1 cut-ins · 1 help requests · test runs: pass');
  fs.rmSync(home, { recursive: true, force: true });
});

test('a driver command that loosens the sandbox is refused', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-home-'));
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [{ id: 'claude', label: 'N', headless: ['true'] }] }));
  const cfg = path.join(home, 'pair.json');
  fs.writeFileSync(cfg, JSON.stringify({ task: 'x', tests: FIX, proof: ['true'], driver: { start: ['codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', '-'] } }));
  let err = '';
  try { execFileSync('node', [path.join(__dirname, '..', 'pair.js'), cfg], { env: { ...process.env, AGENT_DISPATCH_HOME: home }, encoding: 'utf8', stdio: 'pipe' }); }
  catch (e) { err = String(e.stderr); }
  expect(err).toContain('may not loosen the sandbox');
  fs.rmSync(home, { recursive: true, force: true });
});
