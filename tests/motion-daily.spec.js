// motion-daily.js: the morning run, with fake agents and a local show repo.
const { test, expect } = require('@playwright/test');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// A show repo with Motions 1 and 2 on main and the day's queue file on `queue`.
function show(queue) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-show-'));
  const origin = path.join(root, 'origin.git'), seed = path.join(root, 'seed'), clone = path.join(root, 'the-motion');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, seed);
  git(seed, 'config', 'user.email', 't@t'); git(seed, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(seed, '_episodes'));
  for (const n of [1, 2]) fs.writeFileSync(path.join(seed, '_episodes', `motion-${n}.md`), '---\n---\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'site'); git(seed, 'push', '-q', 'origin', 'HEAD:main');
  git(seed, 'checkout', '-q', '-b', 'queue');
  fs.mkdirSync(path.join(seed, 'queue'));
  fs.writeFileSync(path.join(seed, 'queue', '2026-11-02.json'), JSON.stringify(queue));
  git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'queue'); git(seed, 'push', '-q', 'origin', 'queue');
  git(root, 'clone', '-q', origin, clone);
  git(clone, 'config', 'user.email', 't@t'); git(clone, 'config', 'user.name', 't');
  return { root, origin, clone };
}

// Fake agents: openings name the motion, so the editor's screen can tell them apart.
function home(repo, review) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-home-'));
  const agent = name => ['sh', '-c', `case "$1" in
    *"Reply SPLIT or AGREE"*) case "$1" in *"tabs"*) printf 'AGREE\\tBoth like tabs.';; *) printf 'SPLIT\\tThey differ.';; esac;;
    *"Check this episode"*) printf '${review}';;
    *"Pick the one line"*) printf '9\\tNow for, claude.';;
    *"You are the editor"*) echo "A short summary.";;
    *"Before you meet"*) echo "Opening by ${name}.";;
    *"you are alone"*) echo "Now for, ${name}.";;
    *) echo "Turn by ${name}.";; esac`, 'x', '{prompt}'];
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify({ agents: [
    { id: 'claude', label: 'Claude Code', model: 'm-1', headless: agent('claude') },
    { id: 'antigravity', label: 'Antigravity CLI', headless: agent('antigravity') },
  ] }));
  fs.writeFileSync(path.join(dir, 'motion-daily.json'), JSON.stringify({ repo, github: 'x/the-motion', site: 'https://example.com/show', redact: [] }));
  return dir;
}

const M = (motion) => ({ motion: `This house believes ${motion}`, brief: 'B.', source: 'https://example.com/s', source_name: 'Example, November 2026' });
const daily = (dir, ...args) => spawnSync('node', [path.join(__dirname, '..', 'motion-daily.js'), '--date', '2026-11-02', ...args],
  { env: { ...process.env, AGENT_DISPATCH_HOME: dir, AGENT_DISPATCH_CONFIG: path.join(dir, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
const result = s => JSON.parse(git(s.clone, 'show', 'origin/queue:queue/2026-11-02.result.json'));

test('a pick that does not split falls back to the backup; an episode the editor holds gets no pull request', () => {
  const s = show({ pick: M('tabs beat spaces.'), backup: M('monorepos win.'), shortlist: [], why: 'w' });
  const r = daily(home(s.clone, 'HOLD\\tGemini gets the date wrong.'));
  expect(r.stderr).toBe('');
  git(s.clone, 'fetch', '-q', 'origin', 'queue');
  const res = result(s);
  expect(res).toMatchObject({ number: 3, status: 'held', motion: 'This house believes monorepos win.', why: "Editor's check: Gemini gets the date wrong." });
  expect(res.screened.map(x => x.split)).toEqual([false, true]);
  expect(res.pr).toBeUndefined();
  // The held episode is kept on the queue branch for a person to read.
  expect(git(s.clone, 'show', 'origin/queue:queue/2026-11-02/motion-3.md')).toContain('summary: "A short summary."');
  // Nothing reached main, and a second run the same day does nothing.
  expect(git(s.clone, 'ls-tree', '--name-only', 'origin/main', '_episodes/')).not.toContain('motion-3');
  expect(daily(home(s.clone, 'OK')).stdout).toContain('2026-11-02 has already run.');
});

test('when neither motion splits the agents, the day is held before the debate', () => {
  const s = show({ pick: M('tabs beat spaces.'), backup: M('tabs beat everything.'), shortlist: [], why: 'w' });
  const r = daily(home(s.clone, 'OK'));
  expect(r.status).toBe(0);
  git(s.clone, 'fetch', '-q', 'origin', 'queue');
  const res = result(s);
  expect(res.status).toBe('held');
  expect(res.why).toContain('Neither the pick nor the backup');
  expect(res.run).toBeUndefined();
});

test('with nothing queued for the day, it does nothing', () => {
  const s = show({ pick: M('x.') });
  const r = spawnSync('node', [path.join(__dirname, '..', 'motion-daily.js'), '--date', '2026-11-03'],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home(s.clone, 'OK'), AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('Nothing queued for 2026-11-03.');
});
