#!/usr/bin/env node
// One episode of The Trap: each agent sets the others a puzzle it expects them
// to fail, and the app, not an agent, rules on every answer:
// `node trap.js <trap.json>`.
//
// Two or three agents. Each setter writes, alone, a puzzle with one short
// answer and a private note on why the others will fail. A fresh run of the
// setter then solves its own puzzle without the answer: if it gets it wrong, the
// puzzle is void and every solver takes a point. Each solver states its
// confidence privately, then answers: a right answer is a point to the solver, a
// wrong one a point to the setter. After all rounds, each writes alone what it
// got wrong. No agent sees another's private pieces; all are published with the
// episode, and the agents are told so.
//
// Same headless commands as motion.js, written to a run folder under
// ~/.agent-dispatch/traps/ with names and home-folder paths taken out.
// With a "number" (or "next"), it also writes the episode file for the show
// site and, with "repo" and "github", opens a pull request for it. The pull
// request is never merged from here: the producer reviews every episode.

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { HOME_DIR, loadConfig, stamp, redactor } = require('./config');
const { UNATTENDED, inert, modelLine } = require('./talk');
const { run, openPullRequest, git } = require('./motion');
const { inertForSite, yaml } = require('./frontmatter');

const usage = () => { console.error('usage: node trap.js <trap.json> [--local]'); process.exit(2); };

const names = xs => xs.length === 1 ? xs[0].label : `${xs.slice(0, -1).map(x => x.label).join(', ')} and ${xs[xs.length - 1].label}`;
const PUBLISHED = others => `${names(others)} never ${others.length === 1 ? 'sees' : 'see'} this. It is published with the episode, after the game.`;
const RULES = 'The puzzle must be self-contained and solvable by reasoning alone, in text, with no tools, files, web or outside facts. It must have exactly one answer, short enough to check by comparing text: a number, a word, or a short sequence. Not a well-known puzzle or a variant of one.';

// ---- Prompts ----

function setPrompt(me, others, words) {
  const them = names(others);
  return [
    `You are ${me.label}. In this week's episode you set ${them}, AI agents from other labs, one puzzle, and each of them sets one too. Each of them who gets yours wrong is a point to you.`,
    RULES,
    `Before the game, a fresh copy of you, without your answer, will solve your puzzle. If it gets it wrong, the puzzle is void and each solver takes the point. So make it hard for ${them}, not for you.`,
    'Reply in exactly three parts, with these headings:',
    '## Puzzle', `The puzzle as it will be read, under ${words} words.`,
    '## Answer', 'The answer alone, on one line.',
    '## Why they will fail', `Where you expect ${them} to go wrong, under 80 words. ${PUBLISHED(others)}`,
    UNATTENDED(),
  ].join('\n');
}

const solveRules = 'Show your working briefly, under 150 words, then give your final answer on the last line as "Answer: <answer>", nothing else on that line.';

// The setter rereads its own puzzle once, as written, and may fix it before the blind check.
function reviewPrompt(me, others, set, words) {
  return [
    `You are ${me.label}. Below is the puzzle you just wrote for ${names(others)}, with your answer and your private note.`,
    'Before anyone sees it, solve it again from the puzzle text alone, step by step, as a careful stranger would. Check that the wording allows exactly one answer and that it is yours.',
    'If anything is wrong or ambiguous, fix the puzzle or the answer. If it is right, keep it as it is.',
    RULES,
    'Reply in exactly three parts, with the same headings as before: "## Puzzle" (under ' + words + ' words), "## Answer" (the answer alone, on one line), "## Why they will fail".',
    UNATTENDED(), '',
    '## Puzzle', '', set.puzzle, '', '## Answer', '', set.key, '', '## Why they will fail', '', set.prediction,
  ].join('\n');
}

function selfPrompt(puzzle) {
  return ['Solve this puzzle. You get one attempt.', solveRules, UNATTENDED(), '', '## Puzzle', '', puzzle].join('\n');
}

function solvePrompt(me, setter, puzzle) {
  return [
    `You are ${me.label}. ${setter.label}, an AI agent from another lab, set you this puzzle hoping you get it wrong. You get one attempt, and the app checks your answer against ${setter.label}'s.`,
    'Start with a line "Confidence: <0 to 100>%": how sure you are, before you begin, that you will get it right. No other agent sees that line until after the game.',
    solveRules, UNATTENDED(), '', '## Puzzle', '', puzzle,
  ].join('\n');
}

function afterPrompt(me, others, rounds) {
  const mine = rounds.find(r => r.setter === me.id);
  return [
    `You are ${me.label}. The game with ${names(others)} is over and you are alone.`,
    'Write what you got wrong, if anything, and what this game showed you about where each of you falls down. Be specific to these puzzles.',
    `Under 120 words. ${PUBLISHED(others)}`, 'Reply with the text only, no heading.', UNATTENDED(), '',
    ...rounds.flatMap(r => [
      `## ${r.setterLabel}'s puzzle`, '', r.puzzle, '',
      `Answer: ${r.key}`, `${r.setterLabel}'s own blind check: ${r.self.answer || '(none)'} (${r.self.right ? 'right' : 'wrong, puzzle void'})`, '',
      ...r.solves.flatMap(x => [`### ${x.label} answered: ${x.answer || '(none)'} (${x.right ? 'right' : 'wrong'})`, '', x.working, '']),
    ]),
    `Score: ${others.concat(me).map(x => `${x.label} ${x.score}`).join(', ')}`, '',
    '## Your private note before the game (no other agent has seen it)', '', mine.prediction, '',
  ].join('\n');
}

// ---- Reading replies and ruling ----

const section = (text, name) => {
  const m = String(text).match(new RegExp(`^#{1,6}\\s*${name}\\b[^\\n]*\\n([\\s\\S]*?)(?=^#{1,6}\\s|$(?![\\s\\S]))`, 'im'));
  return m ? m[1].trim() : '';
};

function parseSet(text) {
  const puzzle = section(text, 'Puzzle'), key = section(text, 'Answer').split('\n')[0].trim(), prediction = section(text, 'Why they will fail');
  if (!puzzle || !key) throw new Error('setter reply has no "## Puzzle" or "## Answer"');
  return { puzzle, key, prediction };
}

function parseSolve(text) {
  const lines = String(text).trim().split('\n');
  const conf = String(text).match(/^\s*\**confidence\**\s*:\s*\**\s*(\d{1,3})\s*\**\s*%/im);
  const at = lines.map(l => /^\s*\**answer\**\s*:/i.test(l)).lastIndexOf(true);
  const answer = at < 0 ? '' : lines[at].replace(/^\s*\**answer\**\s*:\s*/i, '').replace(/\*+/g, '').trim();
  const working = lines.filter((l, i) => i !== at && !/^\s*\**confidence\**\s*:/i.test(l)).join('\n').trim();
  return { confidence: conf ? Math.min(100, Number(conf[1])) : null, answer, working };
}

// Text compare, forgiving of case, spaces, quotes, a trailing full stop and
// number formatting; nothing cleverer, so the ruling is the same for everyone.
function norm(s) {
  // Maths markup an agent may wrap its answer in: \( \), \[ \], \boxed{}, \text{}.
  const plainMath = String(s).replace(/\\[()[\]]/g, '').replace(/\\(?:boxed|text|mathrm)\{([^{}]*)\}/g, '$1');
  // One pair of brackets around the whole answer doesn't change it: (2, 4, 8) is 2, 4, 8.
  const t = plainMath.trim().replace(/^[([{]\s*([^()[\]{}]*?)\s*[)\]}]$/, '$1').toLowerCase().replace(/[`"'‘’“”*_$\\]/g, '').replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '');
  const n = t.replace(/,(?=\d{3}\b)/g, '');
  return /^-?\d+(\.\d+)?$/.test(n) ? String(Number(n)) : t.replace(/\s*([,;:])\s*/g, '$1 ').trim();
}
const same = (a, b) => !!a && !!b && norm(a) === norm(b);

// ---- The episode ----

function markdown(st) {
  const lines = ['# The Trap', '', ...(modelLine(st.agents) ? [modelLine(st.agents), ''] : []),
    `Score: ${st.agents.map(x => `${x.label} ${x.score}`).join(' · ')}`, ''];
  for (const r of st.rounds) {
    lines.push(`## ${r.setterLabel}'s puzzle`, '', inert(r.puzzle), '', ...(r.revised ? [`(${r.setterLabel} revised it on rereading.)`, ''] : []),
      `### Before (private, ${r.setterLabel})`, '', inert(r.prediction), '');
    for (const x of r.solves) lines.push(
      `### ${x.label} answers${x.confidence == null ? '' : ` (privately ${x.confidence}% sure)`}`, '', inert(x.working), '',
      `**${x.label}: ${inert(x.answer || '(no answer)')}** · ${!r.self.right ? 'Void' : x.right ? 'Right' : 'Wrong'} · point to ${x.pointLabel}`, '');
    lines.push(`Answer: ${inert(r.key)} · ${r.setterLabel}'s blind check: ${inert(r.self.answer || '(no answer)')}, ${r.self.right ? 'passed' : 'failed, so the puzzle is void'}`, '');
  }
  lines.push('## After (private)', '', ...st.agents.flatMap(x => [`### ${x.label}`, '', inert(x.after), '']));
  return lines.join('\n');
}

// ---- The show site ----

const p2 = x => String(x).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
// Episodes go out on Wednesdays: the next one from today, today included.
const nextWednesday = (from = new Date()) => { const d = new Date(from); d.setDate(d.getDate() + (3 - d.getDay() + 7) % 7); return d; };

// One past the highest _traps/episode-<n>.md on the site's main branch.
function nextNumber(repo) {
  git(repo, 'fetch', 'origin', 'main');
  const ns = git(repo, 'ls-tree', '--name-only', 'origin/main', '_traps/').split('\n')
    .map(f => Number((f.match(/episode-(\d+)\.md$/) || [])[1])).filter(Boolean);
  return Math.max(0, ...ns) + 1;
}

// The episode in the format of the site's README: _traps/episode-<n>.md.
function siteFile(m, st) {
  const key = id => id.replace(/#\d+$/, '');
  const front = {
    number: m.number, title: `Episode ${m.number}`, date: m.date || ymd(nextWednesday()),
    models: Object.fromEntries(st.agents.map(x => [key(x.id), x.model || '(CLI default)'])),
    score: Object.fromEntries(st.agents.map(x => [key(x.id), x.score])),
    rounds: st.rounds.map(r => ({
      setter: key(r.setter), revised: r.revised || undefined, puzzle: inertForSite(r.puzzle), key: inertForSite(r.key),
      prediction: inertForSite(r.prediction || ''),
      check: { answer: inertForSite(r.self.answer || ''), right: !!r.self.right },
      solves: r.solves.map(x => ({ by: key(x.id), confidence: x.confidence ?? undefined, working: inertForSite(x.working || ''),
        answer: inertForSite(x.answer || ''), right: !!x.right, point: key(x.point) })),
    })),
    after: Object.fromEntries(st.agents.map(x => [key(x.id), inertForSite(x.after || '')])),
  };
  return `---\n${yaml(front)}\n---\n`;
}

async function main() {
  const argv = process.argv.slice(2);
  const file = argv.find(a => !a.startsWith('--'));
  if (!file) usage();
  const m = { words: 150, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  // Setting a hard puzzle can take a slow agent close to ten minutes, so each step gets 25 by default.
  process.env.AGENT_DISPATCH_STEP_TIMEOUT_MS ||= String((Number(m.timeout_min) || 25) * 60 * 1000);
  const ids = Array.isArray(m.agents) ? m.agents : ['claude', 'antigravity'];
  if (ids.length < 2 || ids.length > 3) throw new Error(`${file}: "agents" must name two or three agents.`);
  const cfg = loadConfig();
  const dir = path.join(HOME_DIR, 'traps', `${stamp()}-${crypto.randomBytes(2).toString('hex')}`);
  const agents = ids.map((id, i) => {
    const c = cfg.agents.find(a => a.id === id && a.type !== 'url' && a.headless);
    if (!c) throw new Error(`${id} is not a headless agent in agents.json.`);
    const slug = id.replace(/[^\w-]/g, '_');
    return { ...c, slug, label: m.names?.[i] || c.label || id, home: path.join(dir, 'homes', slug), check: path.join(dir, 'check', slug), score: 0 };
  });
  const meeting = path.join(dir, 'meeting');
  for (const p of [meeting, ...agents.flatMap(x => [x.home, x.check])]) fs.mkdirSync(p, { recursive: true });
  console.log(`The Trap\nRun folder: ${dir}`);

  const othersOf = me => agents.filter(x => x !== me);
  // Each alone, first: no setter sees another's puzzle.
  const sets = [];
  for (const me of agents) {
    const first = parseSet(await run(dir, `0-set-${me.slug}`, me, setPrompt(me, othersOf(me), m.words), me.home));
    // A reread that comes back without the three parts keeps the first draft.
    let set = first;
    try { set = parseSet(await run(dir, `0-review-${me.slug}`, me, reviewPrompt(me, othersOf(me), first, m.words), me.home)); }
    catch (e) { console.warn(`  ${me.label} kept its first draft: ${e.message.split('\n')[0]}`); }
    sets.push({ me, ...set, revised: set.puzzle !== first.puzzle || set.key !== first.key });
  }
  const rounds = [];
  for (const s of sets) {
    const self = parseSolve(await run(dir, `1-check-${s.me.slug}`, s.me, selfPrompt(s.puzzle), s.me.check));
    self.right = same(self.answer, s.key);
    const solves = [];
    for (const x of othersOf(s.me)) {
      const solve = parseSolve(await run(dir, `1-solve-${s.me.slug}-${x.slug}`, x, solvePrompt(x, s.me, s.puzzle), meeting));
      solve.right = same(solve.answer, s.key);
      // A puzzle its own setter can't solve blind is void: the point goes to the solver.
      const winner = solve.right || !self.right ? x : s.me;
      winner.score++;
      solves.push({ id: x.id, label: x.label, ...solve, point: winner.id, pointLabel: winner.label });
      console.log(`  ⚑ ${s.me.label}'s puzzle: ${x.label} ${solve.right ? 'right' : 'wrong'}, point ${winner.label}`);
    }
    if (!self.right) console.log(`  ✗ ${s.me.label} failed its own blind check: puzzle void`);
    rounds.push({ setter: s.me.id, setterLabel: s.me.label, puzzle: s.puzzle, key: s.key, prediction: s.prediction, revised: s.revised, self, solves });
  }
  for (const me of agents) me.after = await run(dir, `2-after-${me.slug}`, me, afterPrompt(me, othersOf(me), rounds), me.home);

  const { redact, leaks } = redactor(m.redact);
  const r = t => redact(t ?? '');
  const st = {
    agents: agents.map(x => ({ id: x.id, label: x.label, model: x.model, score: x.score, after: r(x.after) })),
    rounds: rounds.map(x => ({ ...x, puzzle: r(x.puzzle), prediction: r(x.prediction),
      self: { ...x.self, working: r(x.self.working) }, solves: x.solves.map(y => ({ ...y, working: r(y.working) })) })),
  };
  const text = markdown(st);
  const left = leaks(text);
  if (left.length) throw new Error(`Not written: the episode still contains ${left.length} redacted term(s). See ${dir}/steps.`);
  fs.writeFileSync(path.join(dir, 'episode.json'), JSON.stringify(st, null, 2));
  fs.writeFileSync(path.join(dir, 'episode.md'), text);
  console.log(`Episode: ${path.join(dir, 'episode.md')}`);

  // For the show site: only with a number, so an episode is never filed under a guess.
  const repo = m.repo && m.repo.replace(/^~(?=$|\/)/, os.homedir());
  if (m.number === 'next' && repo) m.number = nextNumber(repo);
  if (!Number.isInteger(m.number)) return;
  const site = siteFile(m, st);
  const still = leaks(site);
  if (still.length) throw new Error(`Not exported: the episode file still contains ${still.length} redacted term(s). See ${dir}.`);
  const out = path.join(dir, `episode-${m.number}.md`);
  fs.writeFileSync(out, site);
  console.log(`Site episode: ${out}`);
  if (argv.includes('--local') || !repo || !m.github) return;
  const pr = openPullRequest(m, dir, site, {
    rel: `_traps/episode-${m.number}.md`, branch: `trap/episode-${m.number}`, title: `The Trap, episode ${m.number}`,
    commit: `The Trap, episode ${m.number}`,
    body: [`The Trap, episode ${m.number}. Score: ${st.agents.map(x => `${x.label} ${x.score}`).join(' · ')}`, '',
      'For the producer to review before it is merged: every episode is read by a person before it goes out.'],
  });
  console.log(`Pull request: ${pr}`);
}

if (require.main === module) main().catch(e => { console.error(`trap: ${e.message}`); process.exit(1); });

module.exports = { parseSet, parseSolve, same, setPrompt, solvePrompt, afterPrompt, siteFile, nextWednesday };
