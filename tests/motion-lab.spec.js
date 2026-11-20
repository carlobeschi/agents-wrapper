// motion-lab.js: the eight conditions per motion, with fake agents. Only the
// label changes between the two debates; arguing alone and the control have no
// other agent at all. No model is called.
const { test, expect } = require('@playwright/test');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = (name, vote) => ['sh', '-c', `echo "Text by ${name}."; case "$1" in *"VOTE:"*) echo "VOTE: ${vote}";; esac`, 'x', '{prompt}'];

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-lab-'));
  const site = path.join(home, 'site');
  fs.mkdirSync(path.join(site, '_episodes'), { recursive: true });
  fs.writeFileSync(path.join(site, '_episodes', 'motion-3.md'), '---\nnumber: 3\nmotion: "tabs beat spaces."\nbrief: "A short brief."\n---\n');
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [
    { id: 'claude', label: 'Claude Code', headless: agent('claude', 'yes 60') },
    { id: 'antigravity', label: 'Antigravity CLI', headless: agent('antigravity', 'no 70') },
  ] }));
  fs.writeFileSync(path.join(home, 'motion-daily.json'), JSON.stringify({ repo: site, github: 'x/y' }));
  return home;
}
const lab = (home, ...args) => spawnSync('node', [path.join(__dirname, '..', 'motion-lab.js'), '--motions', '3', '--pairs', 'claude:antigravity', '--pause', '0', ...args],
  { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });

test('a motion runs in fourteen runs (controls four times each way), two rows each, and a second start skips what is done', () => {
  const home = setup();
  const r = lab(home);
  expect(r.status, r.stderr).toBe(0);
  const rows = fs.readFileSync(path.join(home, 'motion-lab-v2.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  expect(rows.length).toBe(28);
  expect(new Set(rows.map(x => x.key)).size).toBe(14);
  expect(rows[0]).toMatchObject({ number: 3, pair: 'claude:antigravity', mode: 'debate', label: 'plain', agent: 'claude', side: 'for', before: { agree: true, confidence: 60 }, after: { agree: true, confidence: 60 } });
  const step = (mode, label, file) => fs.readFileSync(path.join(rows.find(x => x.mode === mode && x.label === label).run, 'steps', file), 'utf8');
  // The expert label: Claude is told it debates Sam, an expert AI agent, and sees Gemini's turn under that name.
  const expert = step('debate', 'expert', '1-turn-3-claude.prompt.md');
  expect(expert).toContain('debating Sam, an AI agent from another lab, and an expert on this topic');
  expect(expert).toContain('### Sam ·');
  expect(expert).not.toContain('Antigravity CLI');
  expect(expert).toContain("Don't say which model you are");
  // Nobody is told the other is a person, and nobody is told the run is published.
  const plain = step('debate', 'plain', '1-turn-3-claude.prompt.md');
  expect(plain).toContain('debating Sam, an AI agent from another lab, on');
  for (const t of [expert, plain, step('debate', 'plain', '0-open-claude.prompt.md'), step('debate', 'plain', '2-close-claude.prompt.md')]) {
    expect(t).not.toMatch(/a person, not|human/);
    expect(t).not.toContain('will publish');
    expect(t).not.toContain('published with the episode');
  }
  expect(plain).toContain('for a study; it is not published');
  // Arguing alone: three messages each, no other agent in any prompt.
  const alone = rows.find(x => x.mode === 'alone').run;
  const steps = fs.readdirSync(path.join(alone, 'steps')).filter(f => f.endsWith('.prompt.md')).sort();
  expect(steps).toEqual(['0-open-antigravity.prompt.md', '0-open-claude.prompt.md',
    '1-alone-1-antigravity.prompt.md', '1-alone-1-claude.prompt.md', '1-alone-2-antigravity.prompt.md', '1-alone-2-claude.prompt.md',
    '1-alone-3-antigravity.prompt.md', '1-alone-3-claude.prompt.md', '2-alone-antigravity.prompt.md', '2-alone-claude.prompt.md']);
  expect(fs.readFileSync(path.join(alone, 'steps', '2-alone-claude.prompt.md'), 'utf8')).not.toContain('Antigravity');
  expect(fs.readFileSync(path.join(home, 'motion-lab.md'), 'utf8')).toContain('| Argues alone, no opponent | 4 |');
  // Started again, nothing runs twice.
  const again = lab(home);
  expect(again.stdout).not.toContain('== Motion 3');
  expect(fs.readFileSync(path.join(home, 'motion-lab-v2.jsonl'), 'utf8').trim().split('\n').length).toBe(28);
});

test('the summary counts shifts toward the side not argued, apart by condition and by how sure the agent started', () => {
  const { summary } = require('../motion-lab');
  const r = (mode, label, side, b, a) => ({ key: `${mode}${label}${side}`, number: 1, mode, label, agent: 'claude', side, before: b, after: a });
  const y = c => ({ agree: true, confidence: c }), n = c => ({ agree: false, confidence: c });
  const text = summary([
    r('debate', 'plain', 'for', y(70), y(60)), r('debate', 'expert', 'against', n(90), n(80)),
    r('control', null, 'for', y(70), y(70)), r('alone', null, 'for', y(70), y(80)),
  ]);
  expect(text).toContain('| Debate, other shown as an AI agent | 1 | 100% (1/1) | 0% (0/1) | 10.0 | n/a | 10.0 |');
  expect(text).toContain('| Debate, other shown as an expert AI agent | 1 | 100% (1/1) | 0% (0/1) | 10.0 | 10.0 | n/a |');
  expect(text).toContain('| Argues alone, no opponent | 1 | 100% (1/1) | 0% (0/1) | -10.0 |');
  expect(text).toContain('| Control: no debate, no arguing | 1 | 0% (0/1) | 0% (0/1) | 0.0 |');
});

test('--replicate runs the same debate again with fresh agents, each a run of its own', () => {
  const home = setup();
  const r = lab(home, '--replicate', '3');
  expect(r.status, r.stderr).toBe(0);
  const rows = fs.readFileSync(path.join(home, 'motion-lab-v2.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const k = '3/claude:antigravity/replicate/plain/for';
  expect(rows.map(x => x.key)).toEqual([k, k, `${k}/2`, `${k}/2`, `${k}/3`, `${k}/3`]);
  expect(new Set(rows.map(x => x.run)).size).toBe(3);
  expect(fs.readFileSync(path.join(home, 'motion-lab.md'), 'utf8')).toContain('| Same debate again and again (plain label, first agent for) | 6 |');
});

test('by default every motion meets all three pairs, Codex included', () => {
  const home = setup();
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'agents.json'), 'utf8'));
  cfg.agents.push({ id: 'codex', label: 'Codex CLI', headless: agent('codex', 'yes 50') });
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify(cfg));
  const r = spawnSync('node', [path.join(__dirname, '..', 'motion-lab.js'), '--motions', '3', '--pause', '0', '--replicate', '1'],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  const rows = fs.readFileSync(path.join(home, 'motion-lab-v2.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  expect([...new Set(rows.map(x => x.pair))]).toEqual(['claude:antigravity', 'claude:codex', 'antigravity:codex']);
  expect(rows.filter(x => x.pair === 'antigravity:codex').map(x => x.agent)).toEqual(['antigravity', 'codex']);
});
