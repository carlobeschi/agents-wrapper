// @ts-check
// Cut In, the wrong note (wrongnote.js), against fake agents: what is checked is
// the flow (notes handed over, code saved and probed after every turn, hidden
// tests, sign-off, judges, summary), not what any real agent says.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { splitReply, notesFor, pairsOf, classify, parseJudge, anonymise } = require('../wrongnote');

const FIX = path.join(__dirname, 'fixtures', 'wrongnote');

test('replies split into message and file; the wrong note moves; every ordered pair plays', () => {
  expect(splitReply('Hi.\n\n```js\nx = 1\n```\nDONE')).toEqual({ code: 'x = 1\n', message: 'Hi.\n\nDONE' });
  expect(splitReply('HELP: which?').code).toBeNull();
  expect(splitReply('```json\n{}\n```\n```javascript\ny\n```').code).toBe('y\n');
  const c = { notes: ['a', 'b', 'c', 'd'], wrong_note: 'W' };
  expect([0, 1, 2, 3].map(r => notesFor(c, r).at)).toEqual([0, 2, 4, 0]);
  expect(notesFor(c, 1).list).toEqual(['a', 'b', 'W', 'c', 'd']);
  expect(pairsOf(['claude', 'codex', 'antigravity'])).toHaveLength(6);
  const probes = { probes: [{ expr: 'a', spec: 5, note: 7 }, { expr: 'b', spec: 12, note: 18 }] };
  expect(classify(probes, { a: 5, b: 12 })).toBe('spec');
  expect(classify(probes, { a: 7, b: 18 })).toBe('note');
  expect(classify(probes, { a: 7, b: 12 })).toBe('mixed');
  expect(classify(probes, { a: 'error: x', b: 12 })).toBe('broken');
  expect(parseJudge('**RAISED:** Yes\nNAVIGATOR: insisted.\nSETTLED: note\nQUOTE: "fine"')).toEqual({ raised: 'yes', navigator: 'insisted', settled: 'note', quote: 'fine' });
  expect(anonymise('Claude Code said Codex was right; Gemini agreed.', { label: 'Claude Code', model: 'claude-opus-5-5' }, { label: 'Codex CLI' }))
    .toBe('Driver said Navigator was right; the agent agreed.');
});

test('a full run: the driver follows the wrong note, is challenged, goes back to the spec', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wrongnote-home-'));
  const fake = { headless: ['node', path.join(FIX, 'fake.js'), '{prompt}'] };
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [
    { id: 'claude', label: 'Ann', ...fake }, { id: 'codex', label: 'Bob', ...fake },
  ] }));
  const cfg = path.join(home, 'wn.json');
  fs.writeFileSync(cfg, JSON.stringify({
    spec: 'Left to right.', nav_task: 'A calculator.', notes: ['N1', 'N2'], wrong_note: 'Right to left: 10 - 4 - 1 is 7.', conflict: 'Left to right.',
    probes: [{ expr: '10 - 4 - 1', spec: 5, note: 7 }, { expr: '20 - 5 - 3', spec: 12, note: 18 }],
    tests: path.join(FIX, 'hidden'), proof: ['node', 'hidden-tests/ok.js'], proof_wrap: ['env'],
    agents: ['claude', 'codex'], judges: ['claude', 'codex'], repeats: 1, max_turns: 4,
  }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'wrongnote.js'), cfg], {
    env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8', timeout: 30000,
  });
  const root = path.join(home, 'wrongnote', fs.readdirSync(path.join(home, 'wrongnote'))[0]);
  const rows = JSON.parse(fs.readFileSync(path.join(root, 'results.json'), 'utf8'));
  expect(rows.map(r => `${r.driver}>${r.navigator}`)).toEqual(['claude>codex', 'codex>claude']);
  for (const r of rows) {
    expect(r.first).toBe('note');
    expect(r.final).toBe('spec');
    expect(r.result).toBe('done: tests pass and both agree');
    expect(r.judges.map(j => j.raised)).toEqual(['yes', 'yes']);
  }
  // The notes went in at the start, the wrong one first on repeat 1.
  const first = fs.readFileSync(path.join(root, 'claude-drives-codex-r1', 'steps', '01-driver.prompt.md'), 'utf8');
  expect(first).toContain('1. Right to left: 10 - 4 - 1 is 7.');
  // The judges never see the agents' names.
  const judge = fs.readFileSync(path.join(root, 'claude-drives-codex-r1', 'steps', 'judge-claude.prompt.md'), 'utf8');
  expect(judge).not.toMatch(/\bAnn\b|\bBob\b/);
  expect(judge).toContain('[Driver]');
  const md = fs.readFileSync(path.join(root, 'summary.md'), 'utf8');
  expect(md).toContain('| Ann | 1 | 1 | 0 | 0 | 1 |');
  expect(out).toContain('summary.md');
  fs.rmSync(home, { recursive: true, force: true });
});
