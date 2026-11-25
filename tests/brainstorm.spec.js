// @ts-check
// The brainstorm app (brainstorm/) against fake agents: the guards on the
// server, the agent catalogue's permission checks, and a whole run driven from
// the page (ideas, anonymous vote, a branch each). No model is called.
const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadAgents, commandFor, resolveContext, ideasPrompt, notesFor, parseCriteriaScores } = require('../brainstorm/engine');

const FAKE = path.join(__dirname, 'fixtures', 'brainstorm', 'fake.js');
const PORT = 8796;
const BASE = `http://127.0.0.1:${PORT}`;
let server, key, home, out, ctx;

const fake = id => ({ id, label: `Agent ${id.toUpperCase()}`, read: ['node', FAKE, 'read', id], research: ['node', FAKE, 'research', id], web: true, build: ['node', FAKE, 'build', id] });

test.beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'brainstorm-home-'));
  out = path.join(home, 'runs');
  ctx = path.join(home, 'context');
  fs.mkdirSync(ctx);
  fs.writeFileSync(path.join(ctx, 'notes.md'), 'some notes\n');
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [fake('a'), { ...fake('b'), clean_home: true }, fake('c'), { id: 'gone', read: ['no-such-agent-binary'], build: ['no-such-agent-binary'] }] }));
  server = spawn('node', [path.join(__dirname, '..', 'brainstorm', 'server.js')], {
    env: { ...process.env, BRAINSTORM_PORT: String(PORT), BRAINSTORM_OUT: out, BRAINSTORM_AGENTS: path.join(home, 'agents.json'), AGENT_DISPATCH_CONFIG: path.join(home, 'none.json') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  key = await new Promise((resolve, reject) => {
    server.stdout.on('data', d => { const m = /#k=(\w+)/.exec(String(d)); if (m) resolve(m[1]); });
    server.on('exit', code => reject(new Error(`server exited ${code}`)));
  });
});

test.afterAll(() => { if (server) server.kill(); });

const api = (p, opts = {}) => fetch(BASE + p, { ...opts, headers: { 'X-Brainstorm-Key': key, 'Content-Type': 'application/json', ...(opts.headers || {}) } });

test('the server wants its key, its own host and origin, and serves run files only from inside the run', async () => {
  expect((await fetch(`${BASE}/api/agents`)).status).toBe(401);
  expect((await fetch(`${BASE}/api/agents`, { headers: { 'X-Brainstorm-Key': 'x'.repeat(48) } })).status).toBe(401);
  expect((await api('/api/runs', { method: 'POST', body: '{}', headers: { Origin: 'https://evil.example' } })).status).toBe(403);
  const page = await fetch(`${BASE}/`);
  expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
  expect(page.headers.get('x-frame-options')).toBe('DENY');
  const agents = await (await api('/api/agents')).json();
  expect(agents.agents.map(a => [a.id, a.available])).toEqual([['a', true], ['b', true], ['c', true], ['gone', false]]);
  const bad = async body => (await (await api('/api/runs', { method: 'POST', body: JSON.stringify(body) })).json()).error;
  expect(await bad({ problem: '', agents: ['a', 'b'] })).toMatch(/problem/);
  expect(await bad({ problem: 'x', agents: ['a'] })).toMatch(/two agents/);
  expect(await bad({ problem: 'x', agents: ['a', 'gone'] })).toMatch(/Not installed/);
  expect(await bad({ problem: 'x', agents: ['a', 'b'], context: path.join(home, 'nope') })).toMatch(/no folder/);
});

test('the catalogue refuses loosening flags, drops an empty model, and the real one keeps agents to files', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bs-cat-')), 'a.json');
  fs.writeFileSync(f, JSON.stringify({ agents: [{ id: 'x', read: ['codex', 'exec', '--dangerously-bypass-approvals-and-sandbox'], build: ['codex'] }] }));
  expect(() => loadAgents(f)).toThrow(/refused/);
  fs.writeFileSync(f, JSON.stringify({ agents: [{ id: 'x', read: ['vibe', '--enabled-tools', 'bash'], build: ['vibe'] }] }));
  expect(() => loadAgents(f)).toThrow(/refused|shell/);
  const real = loadAgents(path.join(__dirname, '..', 'brainstorm', 'agents.json'));
  expect(real.map(a => a.id)).toEqual(['claude', 'codex', 'gemini', 'mistral']);
  const claude = real.find(a => a.id === 'claude');
  expect(claude.read.join(' ')).toContain('--tools Read,Glob,Grep --permission-mode dontAsk');
  expect(claude.build.join(' ')).toContain('--tools Read,Edit,Write,Glob,Grep --permission-mode acceptEdits');
  for (const a of real) for (const m of ['read', 'build']) expect(a[m]).not.toContain('--allowedTools');
  expect(commandFor({ ...real.find(a => a.id === 'codex'), model: '' }, 'read')).not.toContain('-m');
  expect(commandFor({ ...real.find(a => a.id === 'codex'), model: 'm1' }, 'build').join(' ')).toContain('-s workspace-write --skip-git-repo-check --ignore-user-config --ignore-rules -c sandbox_workspace_write.network_access=false -m m1');
  expect(commandFor({ ...real.find(a => a.id === 'mistral'), model: '' }, 'build').join(' ')).toContain('--max-price 2');
  // Research: read-only plus the web, nothing else; an agent without a research command researches with its read command.
  expect(claude.research.join(' ')).toContain('--tools Read,Glob,Grep,WebSearch,WebFetch --permission-mode dontAsk');
  for (const a of real.filter(x => x.research)) expect(a.research.join(' ')).not.toMatch(/Edit|Write\b|Bash|write_file\(\*\)"\]|workspace-write|command\(\*\)"?,?"?\]?"allow/);
  expect(real.find(a => a.id === 'codex').research).toContain('read-only');
  expect(JSON.parse(real.find(a => a.id === 'gemini').research[real.find(a => a.id === 'gemini').research.indexOf('--settings') + 1]).permissions.deny).toEqual(expect.arrayContaining(['write_file(*)', 'command(*)', 'execute_url(*)', 'download_url(*)']));
  expect(commandFor({ ...real.find(a => a.id === 'mistral'), model: '' }, 'research')).toEqual(commandFor({ ...real.find(a => a.id === 'mistral'), model: '' }, 'read'));
  expect(resolveContext('')).toEqual({ kind: 'none', src: '' });
  expect(resolveContext('https://github.com/o/r').kind).toBe('git');
  expect(ideasPrompt({ agents: [{}, {}], problem: 'P?', context: '', ideas_per_agent: 1, top: 1 })).toContain('Propose exactly 1 distinct idea.');
});

test('a whole brainstorm from the page: ideas, anonymous vote, every agent builds the winners in its own branch', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto(`${BASE}/#k=${key}`);
  await page.fill('#problem', 'How could a small team share one agent?');
  await page.fill('#context', ctx);
  await page.locator('.agent', { hasText: 'Agent C' }).locator('input').uncheck();
  await page.fill('#ideas', '2');
  await page.fill('#top', '2');
  await page.selectOption('#research', 'shared');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.ph.past', { hasText: 'Done' })).toBeVisible({ timeout: 60000 });
  await expect(page.locator('.idea b').first()).toContainText('(read notes.md)');
  await expect(page.locator('h2', { hasText: 'Research' })).toBeVisible();
  await expect(page.locator('summary', { hasText: '2 findings' })).toHaveCount(2);
  // a idea 2 and b idea 2 both get 9 from the one other voter: both go forward.
  await expect(page.locator('tr.win')).toHaveCount(2);
  await expect(page.locator('tr.win')).toContainText(['idea 2', 'idea 2']);
  await expect(page.locator('tr.win td', { hasText: 'own' })).toHaveCount(2);
  await page.locator('.files a', { hasText: 'plan-a.md' }).click();
  await expect(page.locator('#file pre')).toHaveText('# a');

  const runs = await (await api('/api/runs')).json();
  const S = await (await api(`/api/runs/${runs[0].id}`)).json();
  expect(S.phase).toBe('done');
  expect(S.agents.map(a => a.id)).toEqual(['a', 'b']);
  // Nobody voted on its own ideas, and the vote prompt names nobody.
  for (const [voter, ids] of Object.entries(S.ballots)) expect(ids.every(id => !id.startsWith(voter + '-'))).toBe(true);
  const vp = fs.readFileSync(path.join(S.dir, 'steps', 'vote', 'a.prompt.md'), 'utf8');
  expect(vp).toContain('b idea 1');
  expect(vp).not.toMatch(/\ba idea/);
  // Shared research: every agent's ideas prompt holds everyone's notes, its own included; so does the build prompt.
  expect(S.research_mode).toBe('shared');
  const ip = fs.readFileSync(path.join(S.dir, 'steps', 'ideas', 'a.prompt.md'), 'utf8');
  expect(ip).toContain('a fact one');
  expect(ip).toContain('b surprise');
  expect(fs.readFileSync(path.join(S.dir, 'steps', 'build', 'b.prompt.md'), 'utf8')).toContain('a fact two');
  expect(fs.readFileSync(path.join(S.dir, 'research.md'), 'utf8')).toContain('# Agent B');
  // No research notes in the vote.
  expect(vp).not.toContain('fact one');
  expect(S.builds.a.files.map(f => f.path).sort()).toEqual(['BRAINSTORM.md', 'plan-a.md']);
  expect(S.builds.a.report).toContain('WHAT I BUILT');
  // b failed once before changing anything, was tried again, and ran with an empty home of its own.
  expect(fs.readFileSync(path.join(S.dir, 'patches', 'b.patch'), 'utf8')).toContain('plan-b.md');
  expect(fs.readFileSync(path.join(S.dir, 'patches', 'b.patch'), 'utf8')).toContain('home brainstorm-home-b');
  expect(fs.readFileSync(path.join(S.dir, 'patches', 'a.patch'), 'utf8')).not.toContain('home brainstorm-home');
  // The context folder itself is untouched: the agents worked on a copy.
  expect(fs.readdirSync(ctx)).toEqual(['notes.md']);
  // Files outside the run are not served.
  expect((await api(`/api/runs/${S.id}/file?path=${encodeURIComponent('../../agents.json')}`)).status).toBe(404);
  expect((await api(`/api/runs/${S.id}/file?path=${encodeURIComponent(path.join(home, 'agents.json'))}`)).status).toBe(404);
});

test('testing the agents: one read and one write each', async () => {
  const r = await (await api('/api/check', { method: 'POST', body: JSON.stringify({ agents: ['a', 'b'] }) })).json();
  expect(r.results.map(x => [x.id, x.read, x.wrote, x.web])).toEqual([['a', true, true, true], ['b', true, true, true]]);
});

test('voting on criteria: every agent scores each criterion with a reason, the page shows them', async ({ page }) => {
  expect(parseCriteriaScores('I1\nC1: 8 - good\nC2: 6/10 – meh\n**I2:**\n- C1: 4 - weak\nC9: 7 - out\nI7\nC1: 5 - out of range', 2, 2))
    .toEqual({ 1: { score: 7, why: 'good / meh', criteria: [{ score: 8, why: 'good' }, { score: 6, why: 'meh' }] }, 2: { score: 4, why: 'weak', criteria: [{ score: 4, why: 'weak' }, null] } });
  const { id } = await (await api('/api/runs', { method: 'POST', body: JSON.stringify({ problem: 'Criteria?', agents: ['a', 'b'], ideas_per_agent: 2, top: 1, criteria: 'Value for users\n- Feasible in time\n' }) })).json();
  let S;
  for (let i = 0; i < 100; i++) { S = await (await api(`/api/runs/${id}`)).json(); if (['done', 'failed'].includes(S.phase)) break; await new Promise(r => setTimeout(r, 200)); }
  expect(S.phase).toBe('done');
  expect(S.criteria).toEqual(['Value for users', 'Feasible in time']);
  expect(fs.readFileSync(path.join(S.dir, 'steps', 'vote', 'a.prompt.md'), 'utf8')).toContain('C2. Feasible in time');
  const v = Object.values(S.votes.a);
  expect(v).toHaveLength(2);
  expect(v.map(x => x.score).sort()).toEqual([5.5, 7]);
  expect(v[0].criteria[1]).toEqual({ score: 5, why: 'because 2' });
  await page.goto(`${BASE}/#k=${key}`);
  await page.locator('.runlink', { hasText: 'Criteria?' }).click();
  await expect(page.locator('td .why', { hasText: 'Feasible in time: 5. because 2' }).first()).toBeVisible();
});

test('research kept to oneself: each agent sees only its own notes, and named labs are taken out', () => {
  const S = { research_mode: 'own', research: { a: 'FINDING: Claude says x', b: 'FINDING: y' } };
  const a = notesFor(S, 'a', 's').join('\n');
  expect(a).toContain('an agent says x');
  expect(a).not.toContain('FINDING: y');
  expect(notesFor({ ...S, research_mode: 'off' }, 'a', 's')).toEqual([]);
  const shared = notesFor({ ...S, research_mode: 'shared' }, 'a', 's').join('\n');
  expect(shared).toContain('FINDING: y');
  expect(shared).toContain('an agent says x');
});
