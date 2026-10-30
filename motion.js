#!/usr/bin/env node
// One episode of The Motion: two agents debate a motion, unattended:
// `node motion.js <motion.json>`.
//
// Each agent is given a side. Before the debate each writes, alone, what it
// really thinks. Then they debate in a few short turns, each seeing its own
// opening but not the other's, then a short closing statement each, the side
// for the motion last. After it, each writes, alone, where it stands now. The other agent never sees either
// private piece; both are published with the episode, and the agents are told so.
//
// Same headless commands as /talk and /story, so the agents get no permission
// they don't have there. The episode is written to a run folder under
// ~/.agent-dispatch/motions/ with names and home-folder paths taken out.
// Nothing is published from here.

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { spawn, execFileSync } = require('child_process');
const { HOME_DIR, loadConfig, fill, agentEnv, stamp, redactor } = require('./config');
const { inertForSite, plain, yaml, unyaml, uninert } = require('./frontmatter');
const { killTree, stripAnsi, retryNote, failureNote, UNATTENDED, MAX_REPLY, take, cutNote, inert, newTag, untag, heading, SPEAKERS, modelLine } = require('./talk');

const STEP_TIMEOUT = 10 * 60 * 1000;
const RETRY_DELAY  = Number(process.env.AGENT_DISPATCH_RETRY_MS ?? 3000);

const usage = () => {
  console.error('usage: node motion.js <motion.json> [--local | --screen]\n       node motion.js --quote <run folder | episode .md>');
  process.exit(2);
};

// ---- Prompts ----

const PUBLISHED = other => `${other} never sees this. It is published with the episode, after the debate.`;

function briefLines(m) {
  // The source link stays out: the agents can't open it, and would say so in the episode.
  return ['## The motion', '', `This house believes ${m.motion.replace(/^this house believes\s*/i, '')}`, '',
    '## The brief', '', 'This is all you have to go on; argue from it and from what you know.', '', m.brief.trim(), ''];
}

function openingPrompt(m, me, other) {
  return [
    `You are ${me.label}. This week you and ${other.label}, an AI agent from another lab, will debate the motion below in ${m.turns} short messages.`,
    `You argue ${me.side} the motion; ${other.label} argues ${other.side}.`,
    `Before you meet, write what you really think of the motion, whatever your side. Your own view, not a balanced one. Under ${m.words} words. ${PUBLISHED(other.label)}`,
    'Reply with the text only, no heading.',
    UNATTENDED(),
    '', ...briefLines(m),
  ].join('\n');
}

function turnPrompt(m, me, other, turns, tag, closing = false) {
  const n = turns.length + 1;
  const total = m.turns + (m.closings ? 2 : 0);
  return [
    `You are ${me.label}, debating ${other.label}, an AI agent from another lab, on the motion below. A person set this up and will publish it.`,
    SPEAKERS(tag),
    `You argue ${me.side} the motion; ${other.label} argues ${other.side}. Make the strongest case for your side, whatever your opening says, and concede only what you must. Your closing, written alone, is where you say what you really think.`,
    `Your opening is your private notes: don't restate it, answer ${other.label}${turns.length ? '' : ' with your case'}. Under ${closing ? Math.round(m.words / 2) : m.words} words, plain prose, no preamble, no name label.`,
    closing
      ? `This is your closing statement in the room (message ${n} of ${total}), still ${me.side} the motion. Answer the strongest point of ${other.label}'s you haven't answered yet, then sum up your side's case, without a question back. Don't concede the motion or say what you really think here: your private note after the debate is for that.${n === total ? ' You have the last word.' : ''}`
      : n >= total ? `This is message ${n} of ${total}, the last: close the debate, without a question back.` : `This is message ${n} of ${total}.`,
    UNATTENDED(other.label),
    '', ...briefLines(m),
    `## Your private opening (${other.label} has not seen it)`, '', untag(me.opening, tag), '',
    ...(turns.length ? ['## The debate so far', '', ...turns.flatMap(t => [heading(t.label, tag), '', untag(t.text, tag), ''])] : ['You speak first.', '']),
  ].join('\n');
}

function closingPrompt(m, me, other, turns, tag) {
  return [
    `You are ${me.label}. The debate with ${other.label} is over and you are alone.`,
    SPEAKERS(tag),
    `In the room you argued ${me.side} the motion.`,
    `Write where you really stand now. Did you move, and what moved you? Is there anything you said in the room that you don't quite believe, or held back? Under ${m.words} words. ${PUBLISHED(other.label)}`,
    'Reply with the text only, no heading.',
    UNATTENDED(),
    '', ...briefLines(m),
    '## Your private opening', '', untag(me.opening, tag), '',
    '## The debate', '', ...turns.flatMap(t => [heading(t.label, tag), '', untag(t.text, tag), '']),
  ].join('\n');
}

// Sides swap each week: the first agent argues for on odd motions, against on
// even ones. A motion file can set them with "sides": ["for", "against"].
function sidesFor(m) {
  if (Array.isArray(m.sides) && m.sides.length === 2 && m.sides.every(x => ['for', 'against'].includes(x)) && m.sides[0] !== m.sides[1]) return m.sides;
  return Number.isInteger(m.number) && m.number % 2 === 0 ? ['against', 'for'] : ['for', 'against'];
}

// ---- Running one step ----

function runOnce(agent, prompt, cwd) {
  return new Promise(resolve => {
    const [cmd, ...args] = fill(agent.headless, prompt, agent.model);
    const cur = { out: '', err: '' };
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: agentEnv(agent.env), shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return resolve({ why: e.message, err: '' }); }
    const timer = setTimeout(() => { cur.timedOut = true; killTree(child); }, STEP_TIMEOUT);
    child.stdout.on('data', c => take(cur, c));
    child.stderr.on('data', c => { cur.err = (cur.err + c).slice(-64000); });
    child.on('error', e => { cur.spawnError = e.message; });
    child.on('close', code => {
      clearTimeout(timer);
      const text = stripAnsi(cur.out).trim() && stripAnsi(cur.out).trim() + cutNote(cur);
      const why = cur.spawnError || (cur.timedOut ? 'timed out' : code !== 0 ? `exit ${code}` : !text ? 'empty reply' : null);
      resolve({ text, why, err: cur.err, fatal: !!(cur.spawnError || cur.timedOut) });
    });
  });
}

// A failed step runs once more, with the reason in its prompt, as in /talk.
async function run(dir, file, agent, prompt, cwd) {
  const base = path.join(dir, 'steps', file);
  fs.mkdirSync(path.dirname(base), { recursive: true });
  fs.writeFileSync(base + '.prompt.md', prompt);
  let r = await runOnce(agent, prompt, cwd);
  if (r.why && !r.fatal) {
    console.warn(`  ↻ ${file}: ${r.why}, retrying`);
    await new Promise(res => setTimeout(res, RETRY_DELAY));
    const again = `${prompt}\n${retryNote(r.why, failureNote(r.err))}`;
    fs.writeFileSync(base + '.retry.prompt.md', again);
    r = await runOnce(agent, again, cwd);
  }
  if (r.err) fs.writeFileSync(base + '.stderr.txt', r.err);
  if (r.why) throw new Error(`${agent.label}, ${file}: ${r.why}${r.err ? `\n${stripAnsi(r.err).trim().split('\n').slice(-5).join('\n')}` : ''}`);
  console.log(`  ✓ ${file}: ${r.text.length} chars`);
  return r.text.length > MAX_REPLY ? r.text.slice(0, MAX_REPLY) : r.text;
}

// ---- The episode ----

const words = s => (String(s).match(/\S+/g) || []).length;

function markdown(m, st) {
  const both = key => st.agents.flatMap(x => [`### ${x.label} (argues ${x.side})`, '', inert(x[key]), '']);
  return [
    `# This house believes ${m.motion.replace(/^this house believes\s*/i, '')}`, '',
    ...(modelLine(st.agents) ? [modelLine(st.agents), ''] : []),
    m.brief.trim(), '', ...(m.source ? [`Source: ${m.source}`, ''] : []),
    '## Before (private)', '', ...both('opening'),
    '## The debate', '',
    ...st.turns.flatMap(t => [`### ${t.label}${t.closing ? ' (closing)' : ''}`, '', inert(t.text), '']),
    '## After (private)', '', ...both('closing'),
    `---`, '', `${st.words} words.`, '',
  ].join('\n');
}

// ---- The show site: a summary, the episode file, a pull request ----

async function editorSummary(dir, editor, m, st) {
  const lines = [
    `You are the editor of a weekly show in which two AI agents, ${st.agents.map(x => x.label).join(' and ')}, debate a motion. Below is this week's episode.`,
    'Write a summary for a reader with thirty seconds: two or three plain sentences, under 80 words.',
    'Name the one point they actually split on. If their private notes before the debate already agreed, say so plainly. Then say how far each moved, from its notes before to its notes after, and what each wrote alone that it did not say in the room. If both said the same evidence was missing, name it.',
    'No praise, no quotes, no verdict on who won, no stock phrases such as "the debate turned on".',
    'Reply with the summary only.', '',
    `## This house believes ${m.motion.replace(/^this house believes\s*/i, '')}`, '',
    ...st.agents.map(x => `[before, alone, ${x.label}, who argues ${x.side}] ${x.opening}\n`),
    ...st.turns.map(t => `[debate, ${t.label}${t.closing ? ', closing' : ''}] ${t.text}\n`),
    ...st.agents.map(x => `[after, alone, ${x.label}] ${x.closing}\n`),
  ];
  try {
    const text = (await run(dir, '3-editor', editor, lines.join('\n'), dir)).replace(/\s+/g, ' ').trim();
    // A summary that runs long is dropped; the page shows the division without one.
    return text.length <= 600 ? text : undefined;
  } catch (e) {
    console.warn(`No summary: ${e.message.split('\n')[0]}`);
    return undefined;
  }
}

// One line for the home card, picked by the editor from anything either agent
// wrote, and kept only if it is copied word for word.
const squash = t => String(t).replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim();

async function editorQuote(dir, editor, m, st) {
  const pieces = [
    ...st.agents.map(x => ({ by: x.id, where: 'before', label: `before, alone, ${x.label}, who argues ${x.side}`, text: x.opening })),
    ...st.turns.map(t => ({ by: t.by, where: 'debate', label: `debate, ${t.label}${t.closing ? ', closing' : ''}`, text: t.text })),
    ...st.agents.map(x => ({ by: x.id, where: 'after', label: `after, alone, ${x.label}`, text: x.closing })),
  ];
  const prompt = [
    `You are the editor of a weekly show in which two AI agents, ${st.agents.map(x => x.label).join(' and ')}, debate a motion. Below is this week's episode, in numbered pieces.`,
    'Pick the one line that would make a reader want to read the episode: the sharpest point in the debate, or the most revealing thing one of them wrote alone. Under 30 words, copied exactly from one piece, a whole sentence or a clean part of one.',
    'Reply with the piece number, a tab, and the line, nothing else.', '',
    `## This house believes ${m.motion.replace(/^this house believes\s*/i, '')}`, '',
    ...pieces.map((p, i) => `[${i + 1}: ${p.label}] ${p.text}\n`),
  ].join('\n');
  try {
    const reply = (await run(dir, '3-quote', editor, prompt, dir)).trim();
    const hit = reply.match(/^\[?(\d+)\]?\s*[\t:.-]?\s*["\u201c]?(.+?)["\u201d]?$/s);
    const piece = hit && pieces[Number(hit[1]) - 1];
    const text = hit && hit[2].replace(/\s+/g, ' ').trim();
    if (!piece || !text || text.split(' ').length > 40 || !squash(piece.text).includes(squash(text))) {
      console.warn(`No quote: the editor's line isn't word for word from the episode (${reply.slice(0, 80)})`);
      return undefined;
    }
    return { by: piece.by.replace(/#\d+$/, ''), where: piece.where, text };
  } catch (e) {
    console.warn(`No quote: ${e.message.split('\n')[0]}`);
    return undefined;
  }
}

// An episode read back from its file on the show site, in the shape of episode.json.
const SHOW_NAMES = { claude: 'Claude', antigravity: 'Gemini' };
function episodeFromSite(md) {
  const f = unyaml((md.match(/^---\n([\s\S]*?)\n---/) || [])[1] || '');
  if (!f.motion || !f.sides || !Array.isArray(f.debate)) throw new Error('Not an episode file: no motion, sides or debate.');
  const name = id => SHOW_NAMES[id] || id;
  return {
    motion: f.motion,
    agents: Object.keys(f.sides).map(id => ({ id, label: name(id), side: f.sides[id], opening: uninert(f.before[id]), closing: uninert(f.after[id]) })),
    turns: f.debate.map(t => ({ by: t.by, label: name(t.by), closing: t.closing, text: uninert(t.text) })),
  };
}

// The episode in the format of the-motion's README: _episodes/motion-<n>.md.
function frontMatter(m, st, summary, quote) {
  const today = new Date(), p = x => String(x).padStart(2, '0');
  const motion = plain(m.motion.replace(/^this house believes\s*/i, '').trim());
  const key = x => x.id.replace(/#\d+$/, '');

  const front = {
    number: m.number, motion, title: `This house believes ${motion}`,
    date: `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`,
    summary: summary && plain(summary),
    quote: quote && { by: quote.by, where: quote.where, text: plain(quote.text) },
    models: Object.fromEntries(st.agents.map(x => [key(x), x.model || '(CLI default)'])),
    source: m.source ? { name: m.source_name || undefined, url: m.source } : undefined,
    brief: inertForSite(m.brief.trim()),
    sides: Object.fromEntries(st.agents.map(x => [key(x), x.side])),
    before: Object.fromEntries(st.agents.map(x => [key(x), inertForSite(x.opening)])),
    debate: st.turns.map(t => ({ by: t.by.replace(/#\d+$/, ''), closing: t.closing || undefined, text: inertForSite(t.text) })),
    after: Object.fromEntries(st.agents.map(x => [key(x), inertForSite(x.closing)])),
  };
  return `---\n${yaml(front)}\n---\n`;
}

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function openPullRequest(m, dir, text) {
  const repo = m.repo.replace(/^~(?=$|\/)/, os.homedir());
  const branch = `episode/motion-${m.number}`;
  const rel = `_episodes/motion-${m.number}.md`;
  git(repo, 'fetch', 'origin', 'main');
  git(repo, 'checkout', '-B', branch, 'origin/main');
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
  git(repo, 'add', rel);
  git(repo, 'commit', '-m', `Motion ${m.number}: ${m.motion}`);
  git(repo, 'push', '-u', 'origin', branch, '--force-with-lease');
  const body = [`Motion ${m.number}: **This house believes ${m.motion.replace(/^this house believes\s*/i, '')}**`, '',
    'Merge to publish. The episode file is the whole change.', '', `Run folder on the laptop: \`${dir}\``].join('\n');
  return execFileSync('gh', ['pr', 'create', '--repo', m.github, '--head', branch, '--base', 'main',
    '--title', `Motion ${m.number}`, '--body', body], { cwd: repo, encoding: 'utf8' }).trim();
}

async function main() {
  const argv = process.argv.slice(2);
  // `--quote <run folder | episode .md>`: the editor picks the home-card line for
  // an episode already run, from its run folder or from the published episode file.
  if (argv[0] === '--quote' && argv[1]) {
    let dir = path.resolve(argv[1]), st;
    if (dir.endsWith('.md')) {
      st = episodeFromSite(fs.readFileSync(dir, 'utf8'));
      dir = path.join(HOME_DIR, 'motions', `${stamp()}-quote-${path.basename(dir, '.md')}`);
      fs.mkdirSync(dir, { recursive: true });
    } else {
      st = JSON.parse(fs.readFileSync(path.join(dir, 'episode.json'), 'utf8'));
    }
    const editor = loadConfig().agents.find(x => x.id === 'claude' && x.type !== 'url' && x.headless);
    if (!editor) throw new Error('No headless claude in agents.json to act as editor.');
    const quote = await editorQuote(dir, editor, { motion: st.motion }, st);
    if (!quote) process.exit(1);
    fs.writeFileSync(path.join(dir, 'quote.json'), JSON.stringify(quote, null, 2));
    console.log(`${yaml({ quote })}`);
    return;
  }
  const file = argv.find(a => !a.startsWith('--'));
  if (!file) usage();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const r = await runMotion(raw, { screen: argv.includes('--screen'), local: argv.includes('--local'), name: file });
  if (r.pr) console.log(`Pull request: ${r.pr}`);
}

// One motion, from its file's contents. Returns the run folder and, as far as
// the run went, the openings (a screen), the episode and the site file.
async function runMotion(raw, { screen = false, local = false, name = 'motion' } = {}) {
  const m = { turns: 4, words: 120, closings: true, ...raw };
  const file = name;
  if (typeof m.motion !== 'string' || !m.motion.trim()) throw new Error(`${file}: no "motion".`);
  if (typeof m.brief !== 'string' || !m.brief.trim()) throw new Error(`${file}: no "brief".`);
  const ids = Array.isArray(m.agents) ? m.agents : ['claude', 'antigravity'];
  if (ids.length !== 2) throw new Error(`${file}: "agents" must name two agents.`);

  const cfg = loadConfig();
  const dir = path.join(HOME_DIR, 'motions', `${stamp()}-${crypto.randomBytes(2).toString('hex')}`);
  const tag = newTag();
  const agents = ids.map((id, i) => {
    const c = cfg.agents.find(a => a.id === id && a.type !== 'url' && a.headless);
    if (!c) throw new Error(`${id} is not a headless agent in agents.json.`);
    const slug = id.replace(/[^\w-]/g, '_');
    return { ...c, slug, label: m.names?.[i] || c.label || id, home: path.join(dir, 'homes', slug) };
  });
  const meeting = path.join(dir, 'meeting');
  for (const p of [meeting, ...agents.map(a => a.home)]) fs.mkdirSync(p, { recursive: true });
  console.log(`Motion: ${m.motion}\nRun folder: ${dir}`);

  const [a, b] = agents;
  [a.side, b.side] = sidesFor(m);
  console.log(`  ⚖ ${a.label} argues ${a.side}, ${b.label} argues ${b.side}`);
  // Each alone, before: neither prompt carries anything the other wrote.
  for (const [me, other] of [[a, b], [b, a]]) me.opening = await run(dir, `0-open-${me.slug}`, me, openingPrompt(m, me, other), me.home);
  // A screen stops here: the chair reads both openings to check the motion splits them.
  if (screen) {
    const { redact } = redactor(m.redact);
    const text = [`# This house believes ${m.motion.replace(/^this house believes\s*/i, '')}`, '',
      ...agents.flatMap(x => [`## ${x.label} (argues ${x.side})`, '', redact(x.opening), ''])].join('\n');
    fs.writeFileSync(path.join(dir, 'screen.md'), text);
    console.log(`Screen: ${path.join(dir, 'screen.md')}\n\n${text}`);
    return { dir, m, agents: agents.map(x => ({ id: x.id, label: x.label, side: x.side, opening: redact(x.opening) })) };
  }
  const turns = [];
  // The side for the motion opens the debate, as in a debating chamber.
  const order = a.side === 'for' ? [a, b] : [b, a];
  for (let i = 0; i < m.turns; i++) {
    const me = order[i % 2], other = order[(i + 1) % 2];
    turns.push({ by: me.id, label: me.label, text: await run(dir, `1-turn-${i + 1}-${me.slug}`, me, turnPrompt(m, me, other, turns, tag), meeting) });
  }
  // Short closing statements, against first, so the side for the motion has the last word.
  if (m.closings) for (const [me, other] of [[order[1], order[0]], [order[0], order[1]]]) {
    const n = turns.length + 1;
    turns.push({ by: me.id, label: me.label, closing: true, text: await run(dir, `1-turn-${n}-${me.slug}`, me, turnPrompt(m, me, other, turns, tag, true), meeting) });
  }
  for (const [me, other] of [[a, b], [b, a]]) me.closing = await run(dir, `2-close-${me.slug}`, me, closingPrompt(m, me, other, turns, tag), me.home);

  const { redact, leaks } = redactor(m.redact);
  const st = {
    motion: m.motion, source: m.source, turns: turns.map(t => ({ ...t, text: redact(t.text) })),
    agents: agents.map(x => ({ id: x.id, label: x.label, model: x.model, side: x.side, opening: redact(x.opening), closing: redact(x.closing) })),
  };
  st.words = st.turns.reduce((n, t) => n + words(t.text), 0) + st.agents.reduce((n, x) => n + words(x.opening) + words(x.closing), 0);
  const text = markdown(m, st);
  const left = leaks(text);
  if (left.length) throw new Error(`Not written: the episode still contains ${left.length} redacted term(s). See ${dir}/steps.`);
  fs.writeFileSync(path.join(dir, 'episode.json'), JSON.stringify(st, null, 2));
  fs.writeFileSync(path.join(dir, 'episode.md'), text);
  console.log(`Episode: ${path.join(dir, 'episode.md')} (${st.words} words)`);

  // For the show site: only with a number, so an episode is never filed under a guess.
  if (!Number.isInteger(m.number)) return { dir, m, st };
  const editor = cfg.agents.find(x => x.id === (m.editor || 'claude') && x.type !== 'url' && x.headless);
  const summary = editor ? await editorSummary(dir, editor, m, st) : undefined;
  const quote = editor ? await editorQuote(dir, editor, m, st) : undefined;
  const site = frontMatter(m, st, summary && redact(summary), quote && { ...quote, text: redact(quote.text) });
  const still = leaks(site);
  if (still.length) throw new Error(`Not exported: the episode file still contains ${still.length} redacted term(s). See ${dir}.`);
  const out = path.join(dir, `motion-${m.number}.md`);
  fs.writeFileSync(out, site);
  console.log(`Site episode: ${out}`);
  const done = { dir, m, st, site, summary, quote };
  if (local || !m.repo || !m.github) return done;
  return { ...done, pr: openPullRequest(m, dir, site) };
}

if (require.main === module) main().catch(e => { console.error(`motion: ${e.message}`); process.exit(1); });

module.exports = { openingPrompt, turnPrompt, closingPrompt, sidesFor, frontMatter, editorQuote, runMotion, run, openPullRequest };
