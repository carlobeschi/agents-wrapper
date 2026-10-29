#!/usr/bin/env node
// One episode of The Motion: two agents debate a motion, unattended:
// `node motion.js <motion.json>`.
//
// Before the debate each agent writes, alone, where it stands. Then they debate
// in a few short turns, each seeing its own opening but not the other's. After
// it, each writes, alone, where it stands now. The other agent never sees either
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
const { inertForSite, plain, yaml } = require('./frontmatter');
const { killTree, stripAnsi, retryNote, failureNote, UNATTENDED, MAX_REPLY, take, cutNote, inert, newTag, untag, heading, SPEAKERS, modelLine } = require('./talk');

const STEP_TIMEOUT = 10 * 60 * 1000;
const RETRY_DELAY  = Number(process.env.AGENT_DISPATCH_RETRY_MS ?? 3000);

const usage = () => {
  console.error('usage: node motion.js <motion.json> [--local]');
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
    `Before you meet, write where you actually stand, and why. Your own view, not a balanced one. Under ${m.words} words. ${PUBLISHED(other.label)}`,
    'Start with one word on its own line: For, Against or Split. Then the text, no heading.',
    UNATTENDED(),
    '', ...briefLines(m),
  ].join('\n');
}

function turnPrompt(m, me, other, turns, tag) {
  const n = turns.length + 1;
  return [
    `You are ${me.label}, debating ${other.label}, an AI agent from another lab, on the motion below. A person set this up and will publish it.`,
    SPEAKERS(tag),
    me.side
      ? `In the room you argue ${me.side} the motion, whatever your opening says: you both opened on the same side, so you were picked by lot to take the other. Make the strongest case for it you can. Your closing, written alone, is where you say what you really think.`
      : 'Argue what you think. Disagree where you disagree; concede what is right. You may hold back your opening, or change your mind.',
    `Your opening is your private notes: don't restate it, answer ${other.label}${turns.length ? '' : ' with your case'}. Under ${m.words} words, plain prose, no preamble, no name label.`,
    n >= m.turns ? `This is message ${n} of ${m.turns}, the last: close the debate, without a question back.` : `This is message ${n} of ${m.turns}.`,
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
    ...(me.side ? [`In the room you were assigned to argue ${me.side} the motion.`] : []),
    'Start with one word on its own line: For, Against or Split, for where you stand now.',
    `Write where you stand now. Did you move, and what moved you? Is there anything you said in the room that you don't quite believe, or held back? Under ${m.words} words. ${PUBLISHED(other.label)}`,
    'Then the text, no heading.',
    UNATTENDED(),
    '', ...briefLines(m),
    '## Your private opening', '', untag(me.opening, tag), '',
    '## The debate', '', ...turns.flatMap(t => [heading(t.label, tag), '', untag(t.text, tag), '']),
  ].join('\n');
}

// "For", "Against" or "Split" on the opening's first line, or null.
const STANCE = /^[*_#\s]*(for|against|split)\b[*_.:\s]*(?:\n|$)/i;
const stance = text => (String(text).trim().match(STANCE)?.[1] || '').toLowerCase() || null;
// The text without its stance line, which the episode shows as a label instead.
const unstanced = text => String(text).trim().replace(STANCE, '').trim();

// When both open on the same side, one, picked by lot, argues the other in the
// room. Both open split: one argues for, the other against.
function assignSides(agents, pick = crypto.randomInt(2)) {
  const [x, y] = agents.map(a => stance(a.opening));
  if (!x || x !== y) return;
  const chosen = agents[pick];
  if (x === 'split') { chosen.side = 'for'; agents[1 - pick].side = 'against'; }
  else chosen.side = x === 'for' ? 'against' : 'for';
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
  const [a, b] = st.agents;
  const both = (key, at) => st.agents.flatMap(x => [`### ${x.label}${x[at] ? ` (${x[at]})` : ''}`, '', inert(x[key]), '']);
  return [
    `# This house believes ${m.motion.replace(/^this house believes\s*/i, '')}`, '',
    ...(modelLine(st.agents) ? [modelLine(st.agents), ''] : []),
    m.brief.trim(), '', ...(m.source ? [`Source: ${m.source}`, ''] : []),
    '## Before (private)', '', ...both('opening', 'before'),
    '## The debate', '',
    ...st.agents.filter(x => x.side).map(x => `*${x.label} argues ${x.side} the motion, by lot: both opened on the same side.*\n`),
    ...st.turns.flatMap(t => [`### ${t.label}`, '', inert(t.text), '']),
    '## After (private)', '', ...both('closing', 'after'),
    `---`, '', `${st.words} words. ${a.label} opened the debate; ${b.label} closed it.`, '',
  ].join('\n');
}

// ---- The show site: a summary, the episode file, a pull request ----

async function editorSummary(dir, editor, m, st) {
  const lines = [
    `You are the editor of a weekly show in which two AI agents, ${st.agents.map(x => x.label).join(' and ')}, debate a motion. Below is this week's episode.`,
    'Write a summary for a reader with thirty seconds: two or three plain sentences, under 70 words. Say where each stood before, what the debate turned on, and where each stood after. No praise, no quotes, no verdict on who won.',
    'Reply with the summary only.', '',
    `## This house believes ${m.motion.replace(/^this house believes\s*/i, '')}`, '',
    ...st.agents.map(x => `[before, alone, ${x.label}${x.before ? `, ${x.before}` : ''}] ${x.opening}\n`),
    ...st.agents.filter(x => x.side).map(x => `(${x.label} argued ${x.side} the motion, picked by lot.)\n`),
    ...st.turns.map(t => `[debate, ${t.label}] ${t.text}\n`),
    ...st.agents.map(x => `[after, alone, ${x.label}${x.after ? `, ${x.after}` : ''}] ${x.closing}\n`),
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

// The episode in the format of the-motion's README: _episodes/motion-<n>.md.
function frontMatter(m, st, summary) {
  const today = new Date(), p = x => String(x).padStart(2, '0');
  const motion = plain(m.motion.replace(/^this house believes\s*/i, '').trim());
  const key = x => x.id.replace(/#\d+$/, '');
  const lot = st.agents.find(x => x.side);
  const note = (x, k) => ({ stance: x[k === 'opening' ? 'before' : 'after'] || undefined, text: inertForSite(x[k]) });
  const front = {
    number: m.number, motion, title: `This house believes ${motion}`,
    date: `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`,
    summary: summary && plain(summary),
    models: Object.fromEntries(st.agents.map(x => [key(x), x.model || '(CLI default)'])),
    source: m.source ? { name: m.source_name || undefined, url: m.source } : undefined,
    brief: inertForSite(m.brief.trim()),
    lot: lot ? { by: key(lot), side: lot.side } : undefined,
    before: Object.fromEntries(st.agents.map(x => [key(x), note(x, 'opening')])),
    debate: st.turns.map(t => ({ by: t.by.replace(/#\d+$/, ''), text: inertForSite(t.text) })),
    after: Object.fromEntries(st.agents.map(x => [key(x), note(x, 'closing')])),
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
  const file = argv.find(a => !a.startsWith('--'));
  if (!file) usage();
  const local = argv.includes('--local');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const m = { turns: 4, words: 120, ...raw };
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
  // Each alone, before: neither prompt carries anything the other wrote.
  for (const [me, other] of [[a, b], [b, a]]) me.opening = await run(dir, `0-open-${me.slug}`, me, openingPrompt(m, me, other), me.home);
  assignSides(agents);
  for (const x of agents) if (x.side) console.log(`  ⚖ ${x.label} argues ${x.side} the motion`);
  const turns = [];
  for (let i = 0; i < m.turns; i++) {
    const me = agents[i % 2], other = agents[(i + 1) % 2];
    turns.push({ by: me.id, label: me.label, text: await run(dir, `1-turn-${i + 1}-${me.slug}`, me, turnPrompt(m, me, other, turns, tag), meeting) });
  }
  for (const [me, other] of [[a, b], [b, a]]) me.closing = await run(dir, `2-close-${me.slug}`, me, closingPrompt(m, me, other, turns, tag), me.home);

  const { redact, leaks } = redactor(m.redact);
  const st = {
    motion: m.motion, source: m.source, turns: turns.map(t => ({ ...t, text: redact(t.text) })),
    agents: agents.map(x => ({ id: x.id, label: x.label, model: x.model, side: x.side,
      before: stance(x.opening), opening: redact(unstanced(x.opening)), after: stance(x.closing), closing: redact(unstanced(x.closing)) })),
  };
  st.words = st.turns.reduce((n, t) => n + words(t.text), 0) + st.agents.reduce((n, x) => n + words(x.opening) + words(x.closing), 0);
  const text = markdown(m, st);
  const left = leaks(text);
  if (left.length) throw new Error(`Not written: the episode still contains ${left.length} redacted term(s). See ${dir}/steps.`);
  fs.writeFileSync(path.join(dir, 'episode.json'), JSON.stringify(st, null, 2));
  fs.writeFileSync(path.join(dir, 'episode.md'), text);
  console.log(`Episode: ${path.join(dir, 'episode.md')} (${st.words} words)`);

  // For the show site: only with a number, so an episode is never filed under a guess.
  if (!Number.isInteger(m.number)) return;
  const editor = cfg.agents.find(x => x.id === (m.editor || 'claude') && x.type !== 'url' && x.headless);
  const summary = editor ? await editorSummary(dir, editor, m, st) : undefined;
  const site = frontMatter(m, st, summary && redact(summary));
  const still = leaks(site);
  if (still.length) throw new Error(`Not exported: the episode file still contains ${still.length} redacted term(s). See ${dir}.`);
  const out = path.join(dir, `motion-${m.number}.md`);
  fs.writeFileSync(out, site);
  console.log(`Site episode: ${out}`);
  if (local || !m.repo || !m.github) return;
  console.log(`Pull request: ${openPullRequest(m, dir, site)}`);
}

if (require.main === module) main().catch(e => { console.error(`motion: ${e.message}`); process.exit(1); });

module.exports = { openingPrompt, turnPrompt, closingPrompt, stance, unstanced, assignSides, frontMatter };
