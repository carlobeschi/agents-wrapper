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

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

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
  fs.writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/gh-args"\necho https://example.test/pr/1\n`, { mode: 0o755 });
  return { root, origin, repo, gh };
}

const terms = ['Ada Lovelace', 'ada.lovelace@laptop.lan'];

test('commits as the public identity and takes the home folder out of the body', () => {
  const s = site();
  const url = openGuardedPullRequest({
    repo: s.repo, github: 'o/r', branch: 'episode/1', gh: s.gh, terms,
    files: [{ rel: '_shapes/episode-1.md', text: 'drawings\n' }],
    title: 'Episode 1', commit: 'Episode 1',
    body: `Run folder on the laptop: \`${path.join(os.homedir(), '.agent-dispatch', 'x')}\``,
  });
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
    expect(() => openGuardedPullRequest({
      repo: s.repo, github: 'o/r', branch: 'episode/1', gh: s.gh, terms,
      title: 'Episode 1', body: 'ok', commit: 'Episode 1', files,
    })).toThrow(/Not published/);
    expect(sh(s.origin, 'branch', '--list')).not.toContain('episode/1');
    expect(fs.existsSync(path.join(s.root, 'gh-args'))).toBe(false);
  });
}

test('scrubs private terms from the title, body and commit message', () => {
  const s = site();
  openGuardedPullRequest({
    repo: s.repo, github: 'o/r', branch: 'episode/1', gh: s.gh, terms,
    files: [{ rel: 'e.md', text: 'fine' }],
    title: 'Episode for Ada Lovelace', body: 'mail ada.lovelace@laptop.lan', commit: 'by Ada Lovelace',
  });
  const args = fs.readFileSync(path.join(s.root, 'gh-args'), 'utf8');
  const message = sh(s.origin, 'log', '-1', '--format=%B', 'episode/1');
  for (const t of terms) { expect(args).not.toContain(t); expect(message).not.toContain(t); }
  expect(args).toContain('Episode for [redacted]');
});

test('the guard always knows the home folder and user name', () => {
  const { redact, leaks } = guard([], []);
  expect(redact(`${os.homedir()}/x`)).toBe('~/x');
  expect(leaks(`user ${os.userInfo().username}`)).toHaveLength(1);
});
