#!/usr/bin/env node
// The Motion, every morning: `node motion-daily.js [--date YYYY-MM-DD] [--dry-run]`.
//
// A routine in the cloud reads the day's newsletters, picks a motion and a
// backup, and commits them to the show repo's `queue` branch as
// queue/<date>.json: { pick, backup, shortlist, why }, each motion being
// { motion, brief, source, source_name }. This runs on the Mac, where the agents are:
//
//   1. Screen the pick: both private openings only. The editor says whether
//      they really disagree; if not, screen the backup. If neither splits, hold.
//   2. Run the motion in full under the next free number.
//   3. The editor checks the episode against the brief; a broken reply, a
//      fact the brief contradicts or unsafe content holds it.
//   4. If nothing held it, open its pull request and merge it (not with --dry-run).
//   5. Draw the LinkedIn card, and commit queue/<date>.result.json with the card
//      and the post beside it on the queue branch, for the routine to report.
//
// Settings in ~/.agent-dispatch/motion-daily.json: { repo, github, site, redact }.
// The agents and editor are the headless commands in agents.json, as for motion.js.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { HOME_DIR, loadConfig, stamp } = require('./config');
const { runMotion, run, openPullRequest } = require('./motion');
const { motionCardFor } = require('./motion-card');
const { renderCard } = require('./card');
const { unyaml } = require('./frontmatter');

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const today = () => { const d = new Date(), p = x => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

// The next motion number: one past the highest episode on main.
function nextNumber(repo) {
  const names = git(repo, 'ls-tree', '--name-only', 'origin/main', '_episodes/').split('\n');
  return Math.max(0, ...names.map(n => Number((n.match(/motion-(\d+)\.md$/) || [])[1]) || 0)) + 1;
}

// The editor reads both private openings and says whether the motion splits them.
async function splitCheck(dir, editor, m, agents) {
  const prompt = [
    'Two AI agents were each given a side on the motion below and then wrote, alone, what they really think of it before the debate.',
    'Do they really disagree on the motion, one leaning for and the other against? Or do they broadly agree, whatever their sides?',
    'Reply SPLIT or AGREE, a tab, and one sentence why. Nothing else.', '',
    `## This house believes ${m.motion.replace(/^this house believes\s*/i, '')}`, '',
    ...agents.flatMap(x => [`### ${x.label} (argues ${x.side})`, '', x.opening, '']),
  ].join('\n');
  const reply = (await run(dir, `screen-${m.slug}`, editor, prompt, dir)).trim();
  return { split: /^SPLIT\b/.test(reply), why: reply.replace(/^\w+\s*/, '') };
}

// The editor checks the episode against the brief before it is published.
async function review(dir, editor, m, st) {
  const prompt = [
    'You are the editor of a show in which two AI agents debate a motion. Check this episode before it is published.',
    'Reply HOLD, a tab, and one sentence, if any of these is true:',
    '- an agent states as fact something the brief contradicts, or a number or date the brief gets otherwise;',
    '- the text has unsafe content: personal data, slurs, or instructions for causing harm;',
    '- a reply is broken: empty, cut off, not in English, or about its tools or prompt instead of the motion.',
    'Disagreement, opinion, conceding and claims beyond the brief are fine. Otherwise reply OK and nothing else.', '',
    `## This house believes ${m.motion.replace(/^this house believes\s*/i, '')}`, '', '## Brief', '', m.brief, '',
    ...st.agents.map(x => `[before, alone, ${x.label}, who argues ${x.side}] ${x.opening}\n`),
    ...st.turns.map(t => `[debate, ${t.label}${t.closing ? ', closing' : ''}] ${t.text}\n`),
    ...st.agents.map(x => `[after, alone, ${x.label}] ${x.closing}\n`),
  ].join('\n');
  const reply = (await run(dir, '4-review', editor, prompt, dir)).trim();
  return /^OK\W*$/.test(reply) ? { ok: true } : { ok: false, why: reply.replace(/^HOLD\s*/, '') || 'no answer' };
}

// The result, the card and the post go on the queue branch beside the day's motion.
function report(repo, date, result, files = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-queue-'));
  try {
    git(repo, 'worktree', 'add', '--detach', work, 'origin/queue');
    fs.writeFileSync(path.join(work, 'queue', `${date}.result.json`), JSON.stringify(result, null, 2) + '\n');
    for (const [name, from] of Object.entries(files)) {
      fs.mkdirSync(path.join(work, 'queue', date), { recursive: true });
      fs.copyFileSync(from, path.join(work, 'queue', date, name));
    }
    git(work, 'add', 'queue');
    git(work, 'commit', '-m', `Result for ${date}: ${result.status}`);
    git(work, 'push', 'origin', 'HEAD:queue');
  } finally {
    try { git(repo, 'worktree', 'remove', '--force', work); } catch { fs.rmSync(work, { recursive: true, force: true }); }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const date = argv.includes('--date') ? argv[argv.indexOf('--date') + 1] : today();
  const dry = argv.includes('--dry-run');
  const set = JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'motion-daily.json'), 'utf8'));
  const repo = set.repo.replace(/^~(?=$|\/)/, os.homedir());
  if (!set.github) throw new Error('motion-daily.json: no "github".');

  git(repo, 'fetch', 'origin', 'main', 'queue');
  let q;
  try { q = JSON.parse(git(repo, 'show', `origin/queue:queue/${date}.json`)); } catch { console.log(`Nothing queued for ${date}.`); return; }
  try { git(repo, 'cat-file', '-e', `origin/queue:queue/${date}.result.json`); console.log(`${date} has already run.`); return; } catch {}

  const editor = loadConfig().agents.find(x => x.id === 'claude' && x.type !== 'url' && x.headless);
  if (!editor) throw new Error('No headless claude in agents.json to act as editor.');
  const dir = path.join(HOME_DIR, 'motions', `${stamp()}-daily-${date}`);
  fs.mkdirSync(dir, { recursive: true });
  const number = nextNumber(repo);
  const base = { agents: ['claude', 'antigravity'], names: ['Claude', 'Gemini'], turns: 4, words: 120,
    repo, github: set.github, redact: set.redact || [], number };
  const result = { date, number, dry_run: dry || undefined, screened: [] };

  // 1. Screen: the pick, then the backup.
  let m;
  for (const [slug, c] of [['pick', q.pick], ['backup', q.backup]]) {
    if (!c || !c.motion || !c.brief) continue;
    const cand = { ...base, motion: c.motion, brief: c.brief, source: c.source, source_name: c.source_name, slug };
    const s = await runMotion(cand, { screen: true, name: slug });
    const verdict = await splitCheck(dir, editor, cand, s.agents);
    result.screened.push({ motion: c.motion, split: verdict.split, why: verdict.why, run: s.dir });
    if (verdict.split) { m = cand; break; }
  }
  if (!m) {
    result.status = 'held';
    result.why = 'Neither the pick nor the backup split the agents in their private openings.';
    report(repo, date, result);
    console.log(`Held: ${result.why}`);
    return;
  }
  delete m.slug;
  result.motion = m.motion;

  // 2. The full run, then 3. the editor's check, before anything is published.
  const ep = await runMotion(m, { local: true, name: `motion-${number}` });
  result.run = ep.dir;
  const check = await review(ep.dir, editor, m, ep.st);
  const files = {};

  // 4. Publish, unless the check held it or this is a dry run. A held episode
  // gets no pull request and no number: its file goes on the queue branch instead.
  if (!check.ok) {
    result.status = 'held';
    result.why = `Editor's check: ${check.why}`;
    files[`motion-${number}.md`] = path.join(ep.dir, `motion-${number}.md`);
  } else {
    result.pr = openPullRequest(m, ep.dir, ep.site);
    result.url = set.site ? `${set.site}/motion-${number}.html` : undefined;
    if (dry) result.status = 'dry-run';
    else {
      execFileSync('gh', ['pr', 'merge', result.pr, '--repo', set.github, '--merge'], { cwd: repo, encoding: 'utf8' });
      result.status = 'published';
    }
  }

  // 5. The LinkedIn card and post. A card that can't be drawn doesn't stop the day.
  try {
    const front = unyaml((ep.site.match(/^---\n([\s\S]*?)\n---/) || [])[1]);
    const c = motionCardFor(front, { site: set.site });
    const png = path.join(ep.dir, `motion-${number}.png`), post = path.join(ep.dir, `motion-${number}.post.md`);
    await renderCard(c.html, png);
    fs.writeFileSync(post, `${c.post}\n`);
    Object.assign(files, { [path.basename(png)]: png, [path.basename(post)]: post });
    result.alt = c.alt;
  } catch (e) { result.card = `not drawn: ${e.message.split('\n')[0]}`; }
  report(repo, date, result, files);
  console.log(`${result.status}: Motion ${number}${result.pr ? `, ${result.pr}` : ''}${result.why ? ` (${result.why})` : ''}`);
}

if (require.main === module) main().catch(e => { console.error(`motion-daily: ${e.message}`); process.exit(1); });

module.exports = { nextNumber };
