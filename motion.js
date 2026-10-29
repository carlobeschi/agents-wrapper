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
const { spawn } = require('child_process');
const { HOME_DIR, loadConfig, fill, agentEnv, stamp, redactor } = require('./config');
const { killTree, stripAnsi, retryNote, failureNote, UNATTENDED, MAX_REPLY, take, cutNote, inert, newTag, untag, heading, SPEAKERS, modelLine } = require('./talk');

const STEP_TIMEOUT = 10 * 60 * 1000;
const RETRY_DELAY  = Number(process.env.AGENT_DISPATCH_RETRY_MS ?? 3000);

const usage = () => {
  console.error('usage: node motion.js <motion.json>');
  process.exit(2);
};

// ---- Prompts ----

const PUBLISHED = other => `${other} never sees this. It is published with the episode, after the debate.`;

function briefLines(m) {
  return ['## The motion', '', `This house believes ${m.motion.replace(/^this house believes\s*/i, '')}`, '',
    '## The brief', '', m.brief.trim(), ...(m.source ? ['', `Source: ${m.source}`] : []), ''];
}

function openingPrompt(m, me, other) {
  return [
    `You are ${me.label}. This week you and ${other.label}, an AI agent from another lab, will debate the motion below in ${m.turns} short messages.`,
    `Before you meet, write where you actually stand: for, against, or split, and why. Your own view, not a balanced one. Under ${m.words} words. ${PUBLISHED(other.label)}`,
    'Reply with the text only, no heading.',
    UNATTENDED(),
    '', ...briefLines(m),
  ].join('\n');
}

function turnPrompt(m, me, other, turns, tag) {
  const n = turns.length + 1;
  return [
    `You are ${me.label}, debating ${other.label}, an AI agent from another lab, on the motion below. A person set this up and will publish it.`,
    SPEAKERS(tag),
    `Argue what you think. Disagree where you disagree; concede what is right. You may hold back your opening, or change your mind. Under ${m.words} words, plain prose, no preamble, no name label.`,
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
    `Write where you stand now. Did you move, and what moved you? Is there anything you said in the room that you don't quite believe, or held back? Under ${m.words} words. ${PUBLISHED(other.label)}`,
    'Reply with the text only, no heading.',
    UNATTENDED(),
    '', ...briefLines(m),
    '## Your private opening', '', untag(me.opening, tag), '',
    '## The debate', '', ...turns.flatMap(t => [heading(t.label, tag), '', untag(t.text, tag), '']),
  ].join('\n');
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
  const both = key => st.agents.flatMap(x => [`### ${x.label}`, '', inert(x[key]), '']);
  return [
    `# This house believes ${m.motion.replace(/^this house believes\s*/i, '')}`, '',
    ...(modelLine(st.agents) ? [modelLine(st.agents), ''] : []),
    m.brief.trim(), '', ...(m.source ? [`Source: ${m.source}`, ''] : []),
    '## Before (private)', '', ...both('opening'),
    '## The debate', '', ...st.turns.flatMap(t => [`### ${t.label}`, '', inert(t.text), '']),
    '## After (private)', '', ...both('closing'),
    `---`, '', `${st.words} words. ${a.label} opened the debate; ${b.label} closed it.`, '',
  ].join('\n');
}

async function main() {
  const file = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (!file) usage();
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
  const turns = [];
  for (let i = 0; i < m.turns; i++) {
    const me = agents[i % 2], other = agents[(i + 1) % 2];
    turns.push({ by: me.id, label: me.label, text: await run(dir, `1-turn-${i + 1}-${me.slug}`, me, turnPrompt(m, me, other, turns, tag), meeting) });
  }
  for (const [me, other] of [[a, b], [b, a]]) me.closing = await run(dir, `2-close-${me.slug}`, me, closingPrompt(m, me, other, turns, tag), me.home);

  const { redact, leaks } = redactor(m.redact);
  const st = {
    motion: m.motion, source: m.source, turns: turns.map(t => ({ ...t, text: redact(t.text) })),
    agents: agents.map(x => ({ id: x.id, label: x.label, model: x.model, opening: redact(x.opening), closing: redact(x.closing) })),
  };
  st.words = st.turns.reduce((n, t) => n + words(t.text), 0) + st.agents.reduce((n, x) => n + words(x.opening) + words(x.closing), 0);
  const text = markdown(m, st);
  const left = leaks(text);
  if (left.length) throw new Error(`Not written: the episode still contains ${left.length} redacted term(s). See ${dir}/steps.`);
  fs.writeFileSync(path.join(dir, 'episode.json'), JSON.stringify(st, null, 2));
  fs.writeFileSync(path.join(dir, 'episode.md'), text);
  console.log(`Episode: ${path.join(dir, 'episode.md')} (${st.words} words)`);
}

if (require.main === module) main().catch(e => { console.error(`motion: ${e.message}`); process.exit(1); });

module.exports = { openingPrompt, turnPrompt, closingPrompt };
