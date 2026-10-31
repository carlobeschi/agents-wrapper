// publish.js — the one way a show puts anything on GitHub.
//
// Every episode pull request goes through openGuardedPullRequest. Before
// anything is pushed it:
//   - commits as the public identity (PUBLIC_NAME, PUBLIC_EMAIL), never the
//     laptop's git identity, so no real name or hostname email ends up in a
//     commit or in the Co-authored-by line of a squash merge;
//   - replaces the home folder with ~ in the title, body and commit message;
//   - refuses, and pushes nothing, if the files, title, body, commit message or
//     commit identity still hold a private term.
// Private terms: the home folder, the user name, the laptop's own git name and
// email, the macOS full name, and the show's "redact" list.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { redactor } = require('./config');

const PUBLIC_NAME  = 'Carlo';
const PUBLIC_EMAIL = 'carlobeschi@users.noreply.github.com';

const quiet = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
};

// What this machine knows about its owner. Read here, never written into the repo.
// Names count only as a full name (two words or more), so a one-word git name
// like "Claude" doesn't block every episode that mentions the agent.
function privateTerms() {
  const full = t => /\S\s+\S/.test(t) ? t : '';
  return [
    full(quiet('git', ['config', '--global', 'user.name'])),
    quiet('git', ['config', '--global', 'user.email']),
    process.platform === 'darwin' ? full(quiet('id', ['-F'])) : '',
  ].filter(t => t && t !== PUBLIC_NAME && t !== PUBLIC_EMAIL);
}

// A redactor for publishing: the show's list plus this machine's private terms.
function guard(extra = [], terms = privateTerms()) {
  return redactor([...extra, ...terms.map(t => [t, '[redacted]'])]);
}

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_AUTHOR_NAME: PUBLIC_NAME, GIT_AUTHOR_EMAIL: PUBLIC_EMAIL, GIT_COMMITTER_NAME: PUBLIC_NAME, GIT_COMMITTER_EMAIL: PUBLIC_EMAIL },
}).trim();

// files: [{ rel, text }] or [{ rel, src }] (src is copied, and checked if it is text).
// Returns the pull request URL. Throws before pushing if anything private is left.
function openGuardedPullRequest({ repo, github, branch, files, title, body, commit, redact: extra = [], terms, gh = 'gh' }) {
  repo = repo.replace(/^~(?=$|\/)/, os.homedir());
  const { redact, leaks } = guard(extra, terms);
  title = redact(title); body = redact(body); commit = redact(commit);

  const found = new Set([title, body, commit].flatMap(leaks));
  for (const f of files) {
    const text = f.text != null ? String(f.text) : (/\.(md|json|ya?ml|html|svg|txt)$/i.test(f.rel) ? fs.readFileSync(f.src, 'utf8') : '');
    for (const t of leaks(text)) found.add(t);
  }
  if (found.size) throw new Error(`Not published: ${found.size} private term(s) still in the episode, title, body or commit. Nothing was pushed.`);

  git(repo, 'fetch', 'origin', 'main');
  git(repo, 'checkout', '-B', branch, 'origin/main');
  for (const f of files) {
    const to = path.join(repo, f.rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (f.text != null) fs.writeFileSync(to, f.text); else fs.copyFileSync(f.src, to);
    git(repo, 'add', f.rel);
  }
  git(repo, 'commit', '-m', commit);
  const who = git(repo, 'log', '-1', '--format=%an%n%ae%n%cn%n%ce%n%B');
  if (leaks(who).length || !who.startsWith(`${PUBLIC_NAME}\n${PUBLIC_EMAIL}\n${PUBLIC_NAME}\n${PUBLIC_EMAIL}`)) {
    git(repo, 'checkout', '-q', '--detach', 'origin/main');
    throw new Error('Not published: the commit is not under the public identity. Nothing was pushed.');
  }
  git(repo, 'push', '-u', 'origin', branch, '--force-with-lease');
  return execFileSync(gh, ['pr', 'create', '--repo', github, '--head', branch, '--base', 'main',
    '--title', title, '--body', body], { cwd: repo, encoding: 'utf8' }).trim();
}

module.exports = { openGuardedPullRequest, guard, publicGit: git, privateTerms, PUBLIC_NAME, PUBLIC_EMAIL };
