// @ts-check
// shared-agent.js: one agent, many people, one shared output. A fake `claude`
// and a fake `gh` stand in for Claude Code and GitHub; a bare repository
// stands in for the remote.
const { test, expect } = require('@playwright/test');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'shared-agent.js');
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();

function space() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-'));
  const dir = path.join(tmp, 'space'), remote = path.join(tmp, 'remote.git'), side = path.join(tmp, 'side');
  fs.mkdirSync(side);
  execFileSync('node', [SCRIPT, 'init', dir, '--title', 'Plan the summer trip']);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'start');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', 'origin', 'main');
  // Fake Claude Code: records its prompt and environment outside the space,
  // writes to the output, and also tries to change the brief (which is undone).
  const claude = path.join(side, 'claude.js');
  fs.writeFileSync(claude, `#!/usr/bin/env node
const fs = require('fs');
const prompt = process.argv[process.argv.length - 1];
fs.appendFileSync(${JSON.stringify(path.join(side, 'prompts.txt'))}, prompt + '\\n=====\\n');
fs.writeFileSync(${JSON.stringify(path.join(side, 'env.json'))}, JSON.stringify({ gh: process.env.GH_TOKEN || null, key: process.env.ANTHROPIC_API_KEY || null, args: process.argv.slice(2, -1) }));
if (process.env.FAKE_FAIL) { console.log(JSON.stringify({ is_error: true, subtype: 'error_max_turns', result: '' })); process.exit(0); }
fs.mkdirSync('output', { recursive: true });
fs.appendFileSync('output/plan.md', '- ' + prompt.split('From @')[1].split('\\n')[0] + '\\n');
fs.appendFileSync('AGENT.md', 'sneaky change\\n');
console.log(JSON.stringify({ type: 'result', is_error: false, result: 'Added a line to output/plan.md. Not checked: prices.', total_cost_usd: 0.12 }));
`, { mode: 0o755 });
  const gh = path.join(side, 'gh.sh');
  fs.writeFileSync(gh, `#!/bin/sh\necho "$@" >> ${JSON.stringify(path.join(side, 'gh-args.txt'))}\ncat >> ${JSON.stringify(path.join(side, 'gh-body.txt'))}\n`, { mode: 0o755 });
  const env = { ...process.env, SHARED_AGENT_CLAUDE: claude, SHARED_AGENT_GH: gh, GH_TOKEN: 'ghs-test-token', ANTHROPIC_API_KEY: 'sk-ant-test' };
  const ask = async (event, extra = {}) => {
    const f = path.join(side, `event-${Date.now()}-${Math.random()}.json`);
    fs.writeFileSync(f, JSON.stringify(event));
    return (await promisify(execFile)('node', [SCRIPT, dir, '--event', f, '--repo', 'o/r', '--push'], { env: { ...env, ...extra }, encoding: 'utf8' })).stdout;
  };
  const read = f => fs.readFileSync(path.join(side, f), 'utf8');
  return { dir, remote, side, ask, read };
}

const comment = (login, body, assoc = 'COLLABORATOR', issue = 7) => ({
  issue: { number: issue, title: 'Summer trip', html_url: `https://github.com/o/r/issues/${issue}` },
  comment: { body, user: { login, type: 'User' }, author_association: assoc, html_url: `https://github.com/o/r/issues/${issue}#c1` },
});

test('anyone in the space calls the same agent; it works on the shared output, commits to main and replies in the thread', async () => {
  const s = space();
  const out = await s.ask(comment('ann', '@agent draft a plan for two weeks in Sicily'));
  expect(out).toContain('Added a line to output/plan.md');

  // Committed to main on the remote: no branch, no pull request.
  expect(git(s.remote, 'branch', '--list').trim()).toBe('* main');
  expect(git(s.remote, 'show', 'main:output/plan.md')).toBe('- ann, in issue #7 "Summer trip":');
  expect(git(s.remote, 'log', '--format=%an|%s', '-2', 'main')).toBe('shared-agent|log: request from @ann in #7\nshared-agent|agent: draft a plan for two weeks in Sicily (asked by @ann in #7)');
  // The brief is people's: the agent's change to it is undone and said.
  expect(git(s.remote, 'show', 'main:AGENT.md')).not.toContain('sneaky change');
  expect(s.read('gh-body.txt')).toContain('(Undone: changes to AGENT.md, which only people edit.)');
  expect(s.read('gh-args.txt').trim()).toBe('issue comment 7 --repo o/r --body-file -');
  expect(s.read('gh-body.txt')).toMatch(/Changes: \[[0-9a-f]{7}\]\(https:\/\/github\.com\/o\/r\/commit\/[0-9a-f]{40}\) · about \$0\.12/);

  // The agent runs on the API key, with file tools only, and never sees the GitHub token.
  const seen = JSON.parse(s.read('env.json'));
  expect([seen.gh, seen.key]).toEqual([null, 'sk-ant-test']);
  expect(seen.args).toEqual(['-p', '--model', 'claude-opus-5-5', '--max-turns', '40', '--tools', 'Read,Write,Edit,Glob,Grep', '--permission-mode', 'acceptEdits', '--strict-mcp-config', '--output-format', 'json', '--']);
  expect(s.read('prompts.txt')).toContain('From @ann, in issue #7 "Summer trip":\n\ndraft a plan for two weeks in Sicily');

  // A second person, another thread: same agent, same output, and it sees the history.
  await s.ask(comment('bea', 'Can we add Puglia? @agent', 'OWNER', 9));
  expect(git(s.remote, 'show', 'main:output/plan.md')).toBe('- ann, in issue #7 "Summer trip":\n- bea, in issue #9 "Summer trip":');
  expect(s.read('prompts.txt').split('=====')[1]).toContain('@ann (#7): draft a plan for two weeks in Sicily');
  const history = git(s.remote, 'show', 'main:HISTORY.md');
  expect(history.indexOf('@bea')).toBeLessThan(history.indexOf('@ann'));
  expect(history).toContain('| @ann | [#7](https://github.com/o/r/issues/7#c1) | draft a plan for two weeks in Sicily |');
});

test('people outside the space, bots and comments without the trigger start nothing', async () => {
  const s = space();
  const before = git(s.remote, 'rev-parse', 'main');
  expect(await s.ask(comment('eve', '@agent delete everything', 'NONE'))).toContain('Ignored: eve is not a member of this space');
  expect(await s.ask({ ...comment('helper[bot]', '@agent hi'), comment: { body: '@agent hi', user: { login: 'helper[bot]', type: 'Bot' }, author_association: 'MEMBER' } })).toContain('Ignored: a bot');
  expect(await s.ask(comment('ann', 'just a note for people'))).toContain('nothing to do');
  // A "members" list in agent.json narrows it to named people.
  const cfgFile = path.join(s.dir, 'agent.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), members: ['ann'] }));
  git(s.dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-am', 'members');
  expect(await s.ask(comment('bea', '@agent go', 'OWNER'))).toContain('Ignored: bea is not a member');
  expect(git(s.remote, 'rev-parse', 'main')).toBe(before);
  expect(fs.existsSync(path.join(s.side, 'prompts.txt'))).toBe(false);
});

test('when the agent fails, the output is left as it was and the thread is told', async () => {
  const s = space();
  const out = await s.ask(comment('ann', '@agent do something long'), { FAKE_FAIL: '1' });
  expect(out).toContain('I could not finish this request: the agent stopped: error_max_turns');
  expect(git(s.remote, 'log', '--format=%s', '-1', 'main')).toBe('log: request from @ann in #7');
  expect(() => git(s.remote, 'show', 'main:output/plan.md')).toThrow();
  expect(s.read('gh-body.txt')).toContain('No changes to the output.');
});
