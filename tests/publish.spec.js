// @ts-check
// publish.js: an episode pull request is committed under the public identity,
// has the home folder taken out of its text, and is refused, with nothing
// pushed, when a private term is still in it. A bare repo stands in for
// GitHub and a script for gh.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openGuardedPullRequest, guard, PUBLIC_NAME, PUBLIC_EMAIL } = require('../publish');

function withBareRepositoryAllowed(run) {
  const index = Number(process.env.GIT_CONFIG_COUNT || 0);
  const key = `GIT_CONFIG_KEY_${index}`, value = `GIT_CONFIG_VALUE_${index}`;
  const previous = [process.env.GIT_CONFIG_COUNT, process.env[key], process.env[value]];
  process.env[key] = 'safe.bareRepository';
  process.env[value] = 'all';
  process.env.GIT_CONFIG_COUNT = String(index + 1);
  try { return run(); }
  finally {
    if (previous[0] === undefined) delete process.env.GIT_CONFIG_COUNT;
    else process.env.GIT_CONFIG_COUNT = previous[0];
    if (previous[1] === undefined) delete process.env[key];
    else process.env[key] = previous[1];
    if (previous[2] === undefined) delete process.env[value];
    else process.env[value] = previous[2];
  }
}

const sh = (cwd, ...args) => withBareRepositoryAllowed(() => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim());

function site() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-'));
  const origin = path.join(root, 'origin.git'), repo = path.join(root, 'site');
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(root, 'clone', '-q', origin, repo);
  // The laptop's own identity: what must never reach a commit.
  sh(repo, 'config', 'user.name', 'Ada Lovelace');
  sh(repo, 'config', 'user.email', 'ada.lovelace@laptop.lan');
  fs.writeFileSync(path.join(repo, 'README.md'), 'site\n');
  sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', 'start'); sh(repo, 'push', '-q', 'origin', 'main');
  const gh = path.join(root, 'gh');
  fs.writeFileSync(gh, `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  if [ -f "${root}/open-pr" ]; then cat "${root}/open-pr"; fi
  exit 0
fi
printf '%s\\n' "$@" > "${root}/gh-args"
echo https://example.test/pr/1
`, { mode: 0o755 });
  return { root, origin, repo, gh };
}

const terms = ['Ada Lovelace', 'ada.lovelace@laptop.lan'];

test('commits as the public identity and takes the home folder out of the body', () => {
  const s = site();
  const url = withBareRepositoryAllowed(() => openGuardedPullRequest({
    repo: s.repo, github: 'o/r', branch: 'episode/1', gh: s.gh, terms,
    files: [{ rel: '_shapes/episode-1.md', text: 'drawings\n' }],
    title: 'Episode 1', commit: 'Episode 1',
    body: `Run folder on the laptop: \`${path.join(os.homedir(), '.agent-dispatch', 'x')}\``,
  }));
  expect(url).toBe('https://example.test/pr/1');
  const who = sh(s.origin, 'log', '-1', '--format=%an|%ae|%cn|%ce', 'episode/1');
  expect(who).toBe(`${PUBLIC_NAME}|${PUBLIC_EMAIL}|${PUBLIC_NAME}|${PUBLIC_EMAIL}`);
  const args = fs.readFileSync(path.join(s.root, 'gh-args'), 'utf8');
  expect(args).toContain('Run folder on the laptop: `~/.agent-dispatch/x`');
  expect(args).not.toContain(os.homedir());
});

for (const [where, opts] of [
  ['the episode file', { files: [{ rel: 'e.md', text: 'drawn by Ada Lovelace' }] }],
  ['a copied file', { files: [{ rel: 'e.json', src: 'LEAK' }] }],
]) {
  test(`refuses, pushing nothing, when a private term is in ${where}`, () => {
    const s = site();
    const leak = path.join(s.root, 'leak.json');
    fs.writeFileSync(leak, '{"by": "Ada Lovelace"}');
    const files = opts.files.map(f => f.src ? { ...f, src: leak } : f);
    expect(() => withBareRepositoryAllowed(() => openGuardedPullRequest({
      repo: s.repo, github: 'o/r', branch: 'episode/1', gh: s.gh, terms,
      title: 'Episode 1', body: 'ok', commit: 'Episode 1', files,
    }))).toThrow(/Not published/);
    expect(sh(s.origin, 'branch', '--list')).not.toContain('episode/1');
    expect(fs.existsSync(path.join(s.root, 'gh-args'))).toBe(false);
  });
}

test('scrubs private terms from the title, body and commit message', () => {
  const s = site();
  withBareRepositoryAllowed(() => openGuardedPullRequest({
    repo: s.repo, github: 'o/r', branch: 'episode/1', gh: s.gh, terms,
    files: [{ rel: 'e.md', text: 'fine' }],
    title: 'Episode for Ada Lovelace', body: 'mail ada.lovelace@laptop.lan', commit: 'by Ada Lovelace',
  }));
  const args = fs.readFileSync(path.join(s.root, 'gh-args'), 'utf8');
  const message = sh(s.origin, 'log', '-1', '--format=%B', 'episode/1');
  for (const t of terms) { expect(args).not.toContain(t); expect(message).not.toContain(t); }
  expect(args).toContain('Episode for [redacted]');
});

test('resumes when PR creation succeeded remotely but the command failed', () => {
  const s = site();
  fs.writeFileSync(s.gh, `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  if [ -f "${s.root}/open-pr" ]; then cat "${s.root}/open-pr"; fi
  exit 0
fi
if [ -f "${s.root}/created" ]; then exit 2; fi
touch "${s.root}/created"
echo https://example.test/pr/1 > "${s.root}/open-pr"
exit 1
`, { mode: 0o755 });
  const options = {
    repo: s.repo, github: 'o/r', branch: 'episode/1', gh: s.gh, terms,
    files: [{ rel: 'e.md', text: 'fine' }],
    title: 'Episode 1', body: 'ok', commit: 'Episode 1',
  };
  expect(() => withBareRepositoryAllowed(() => openGuardedPullRequest(options))).toThrow();
  const firstCommit = sh(s.origin, 'rev-parse', 'episode/1');
  const url = withBareRepositoryAllowed(() => openGuardedPullRequest(options));
  expect(url).toBe('https://example.test/pr/1');
  expect(sh(s.origin, 'rev-parse', 'episode/1')).toBe(firstCommit);
});

test('refuses to overwrite a remote branch with different content', () => {
  const s = site();
  sh(s.repo, 'checkout', '-b', 'episode/1');
  fs.writeFileSync(path.join(s.repo, 'other.md'), 'different publication\n');
  sh(s.repo, 'add', 'other.md');
  sh(s.repo, 'commit', '-q', '-m', 'other publication');
  sh(s.repo, 'push', '-q', 'origin', 'episode/1');
  sh(s.repo, 'checkout', 'main');
  const original = sh(s.origin, 'rev-parse', 'episode/1');
  expect(() => withBareRepositoryAllowed(() => openGuardedPullRequest({
    repo: s.repo, github: 'o/r', branch: 'episode/1', gh: s.gh, terms,
    files: [{ rel: 'e.md', text: 'fine' }],
    title: 'Episode 1', body: 'ok', commit: 'Episode 1',
  }))).toThrow(/refusing to overwrite/);
  expect(sh(s.origin, 'rev-parse', 'episode/1')).toBe(original);
  expect(fs.existsSync(path.join(s.root, 'gh-args'))).toBe(false);
});

test('the guard always knows the home folder and user name', () => {
  const { redact, leaks } = guard([], [], { user: 'ada', home: '/Users/ada' });
  expect(redact('/Users/ada/x')).toBe('~/x');
  expect(leaks('user ada')).toHaveLength(1);
});

test('a user name that is the public GitHub handle is not a private term', () => {
  const { redact, leaks } = guard([], [], { user: PUBLIC_EMAIL.split('@')[0], home: `/Users/${PUBLIC_EMAIL.split('@')[0]}` });
  expect(leaks(`${PUBLIC_NAME} <${PUBLIC_EMAIL}>`)).toEqual([]);
  expect(redact(`${PUBLIC_EMAIL.split('@')[0]}.github.io`)).toBe(`${PUBLIC_EMAIL.split('@')[0]}.github.io`);
  expect(redact(`/Users/${PUBLIC_EMAIL.split('@')[0]}/.agent-dispatch`)).toBe('~/.agent-dispatch');
});
