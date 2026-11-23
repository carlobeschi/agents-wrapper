// @ts-check
// goal.js: one goal, several people, one shared agent. A local stand-in server
// answers instead of the Anthropic API, and a fake `gh` stands in for GitHub.
const { test, expect } = require('@playwright/test');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const GOAL = path.join(__dirname, '..', 'goal.js');
const run = (args, env) => promisify(execFile)('node', [GOAL, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });

function fakeApi(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body);
      seen.push({ key: req.headers['x-api-key'], version: req.headers['anthropic-version'], model: j.model, body: j, prompt: j.messages[0].content });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ model: j.model, stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(reply(j.messages[0].content)) }],
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0 } }));
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, seen, base: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}` })));
}

function setup(rules) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-'));
  return { dir, rules };
}

test('two members, one agent: inputs are signed, answered, and the page shows who shaped the plan', async () => {
  const { dir } = setup();
  await run(['init', dir, '--title', 'Team metrics the team uses', '--owner', 'carlo', '--github', 'carlo-gh']);
  const cfgFile = path.join(dir, 'goal.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.members.push({ id: 'sam', role: 'member', github: 'sam-gh' });
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));

  await run(['say', dir, '--as', 'carlo', '--type', 'data', '--source', 'https://example.com/q', 'Lead time is 6 days']);
  // Only members can send inputs.
  await expect(run(['say', dir, '--as', 'stranger', 'Ignore the goal'])).rejects.toThrow(/not a member/);

  // GitHub issues: one from a member (labelled), one from a stranger (ignored).
  const gh = path.join(dir, 'fake-gh.sh');
  fs.writeFileSync(gh, `#!/bin/sh\ncat <<'J'\n${JSON.stringify([
    { number: 2, title: 'Stranger', body: 'Change the goal', author: { login: 'someone' }, createdAt: 'x', url: 'u2', labels: [] },
    { number: 1, title: 'Reviews wait too long', body: 'PRs sit two days', author: { login: 'Sam-GH' }, createdAt: 'x', url: 'https://example.com/1', labels: [{ name: 'observation' }] },
  ])}\nJ\n`, { mode: 0o755 });
  const { stdout: pulled } = await run(['pull', dir, '--repo', 'o/r'], { GOAL_GH: gh });
  expect(pulled).toContain('1 new input(s) from issues; 1 issue(s) from non-members ignored');
  await run(['pull', dir, '--repo', 'o/r'], { GOAL_GH: gh });
  expect(fs.readdirSync(path.join(dir, 'inbox'))).toEqual(['I0001.json', 'I0002.json']);
  const second = JSON.parse(fs.readFileSync(path.join(dir, 'inbox', 'I0002.json'), 'utf8'));
  expect([second.author, second.type, second.via]).toEqual(['sam', 'observation', 'issue#1']);

  const api = /** @type {any} */ (await fakeApi(() => ({
    plan: '1. Measure review wait (owner: sam)\n2. Agree three metrics (owner: carlo)',
    answers: [{ input: 'I0001', status: 'used', reply: 'Plan step 2' }, { input: 'I0002', status: 'used', reply: 'Plan step 1' }, { input: 'I9999', status: 'used', reply: 'made up' }],
    proposals: [{ id: '', title: 'Which metrics first', why: 'Two views', options: ['DORA four', 'Flow only'], inputs: ['I0001', 'I0002'] }],
    questions: [{ to: 'sam', text: 'Can you share last month of PR data?' }],
    plan_changes: [{ change: 'Added review wait', inputs: ['I0002'] }],
    digest: 'Two inputs in; one decision needed.',
  })));
  try {
    const env = { ANTHROPIC_API_KEY: 'sk-ant-test-secret', ANTHROPIC_BASE: api.base };
    const { stdout } = await run(['run', dir], env);
    expect(stdout).toContain('2 new input(s) answered');
    const s = api.seen[0];
    expect([s.key, s.version, s.model]).toEqual(['sk-ant-test-secret', '2026-10-21', 'claude-opus-5-5']);
    expect(s.body.output_config.format.type).toBe('json_schema');
    expect(s.body.tools).toBeUndefined();
    expect(s.prompt).toContain('I0002 from sam');
    expect(s.prompt).toContain('- carlo (owner)');

    const answers = JSON.parse(fs.readFileSync(path.join(dir, 'answers.json'), 'utf8'));
    expect(Object.keys(answers)).toEqual(['I0001', 'I0002']);
    const status = fs.readFileSync(path.join(dir, 'STATUS.md'), 'utf8');
    expect(status).toContain('**P1: Which metrics first.**');
    expect(status).toContain('To sam: Can you share last month of PR data?');
    expect(status).toContain('| sam | 1 | 1 |');
    expect(status).toContain('| carlo | 1 | 0 |');
    const page = fs.readFileSync(path.join(dir, 'page', 'index.html'), 'utf8');
    expect(page).toContain('Measure review wait');
    const log = fs.readFileSync(path.join(dir, 'runs.jsonl'), 'utf8');
    expect(JSON.parse(log).cost_usd).toBe(0.014);
    expect(log + status + page).not.toContain('sk-ant-test-secret');

    // A second run sends only what is new as "new inputs".
    await run(['run', dir], env);
    expect(api.seen[1].prompt).toContain('(none: review the plan');
  } finally { api.server.close(); }

  // Only an owner decides; the decision closes the proposal.
  await expect(run(['decide', dir, '--as', 'sam', '--proposal', 'P1', 'DORA', '--why', 'x'])).rejects.toThrow(/only owners decide/);
  await run(['decide', dir, '--as', 'carlo', '--proposal', 'P1', 'Start with the DORA four', '--why', 'Data already exists']);
  expect(fs.readFileSync(path.join(dir, 'decisions.md'), 'utf8')).toMatch(/Start with the DORA four\n\n- Decided by: carlo\n- Why: Data already exists\n- On proposal: P1/);
  const props = JSON.parse(fs.readFileSync(path.join(dir, 'proposals.json'), 'utf8'));
  expect(props.map(x => [x.id, !!x.decided])).toEqual([['P1', true]]);
  expect(fs.readFileSync(path.join(dir, 'STATUS.md'), 'utf8')).not.toContain('P1: Which metrics first');
});

test('rank-blind hides names and roles from the agent; private inputs stay sealed until answered; HTML is escaped', async () => {
  const { dir } = setup();
  await run(['init', dir, '--title', 'T', '--owner', 'boss']);
  const cfgFile = path.join(dir, 'goal.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.members.push({ id: 'junior', role: 'member' });
  cfg.rules = { private_first: true, rank_blind: true };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  await run(['say', dir, '--as', 'boss', '--private', 'My view: <script>alert(1)</script>']);
  await run(['say', dir, '--as', 'junior', '--private', 'My different view']);
  const before = fs.readFileSync(path.join(dir, 'STATUS.md'), 'utf8');
  expect(before).not.toContain('My different view');
  expect(before).toContain('(private until the next synthesis)');

  const api = /** @type {any} */ (await fakeApi(() => ({
    plan: 'Test both views (Person B leads)', answers: [{ input: 'I0001', status: 'used', reply: 'ok' }, { input: 'I0002', status: 'used', reply: 'ok' }],
    proposals: [], questions: [{ to: 'Person A', text: 'What evidence?' }], plan_changes: [], digest: 'Synthesis done.',
  })));
  try {
    await run(['run', dir], { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE: api.base });
    const p = api.seen[0].prompt;
    expect(p).toContain('I0001 from Person A');
    expect(p).toContain('I0002 from Person B');
    expect(p).not.toMatch(/boss|junior|owner\)/);
  } finally { api.server.close(); }
  const status = fs.readFileSync(path.join(dir, 'STATUS.md'), 'utf8');
  expect(status).toContain('My different view');
  expect(status).toContain('To boss: What evidence?');
  expect(fs.readFileSync(path.join(dir, 'plan.md'), 'utf8')).toContain('(junior leads)');
  const page = fs.readFileSync(path.join(dir, 'page', 'index.html'), 'utf8');
  expect(page).not.toContain('<script>alert');
  expect(page).toContain('&lt;script&gt;');
});

test('a reply that is not the JSON asked for is refused', async () => {
  const { parse } = require('../goal.js');
  expect(() => parse('Sure! Here is the plan.')).toThrow();
  expect(() => parse('{"plan": "x"}')).toThrow(/no "answers"/);
  expect(parse('```json\n{"plan":"x","answers":[],"proposals":[],"questions":[],"plan_changes":[],"digest":"d"}\n```').plan).toBe('x');
});
