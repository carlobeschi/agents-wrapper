#!/usr/bin/env node
// An improv show (working title Yes, And): two or three agents build a scene
// from an audience line, one short line each in turn, every line starting
// "Yes, and": `node yesand.js <yesand.json> [--local]`.
//
// "starters": one scene per audience line; the agent who opens rotates. Each
// turn the speaker sees the whole scene so far and adds one line of at most
// "words" words (default 25, "Yes, and" included). The app counts: a line over
// the cap goes back once with the count, then is cut at the cap. The app also
// flags a line that does not open with "Yes, and", or that opens "Yes, and
// no / but / actually ..." (a block). With each line the speaker writes a
// private note on what it was going for. After the scene each agent votes
// alone for the funniest line that is not its own (the app refuses its own,
// once) and may call one line a block; votes received are the score. Then a
// private after note. No agent sees another's private pieces; all are kept
// for the episode.
//
// Same headless commands and run folder rules as scare.js, under
// ~/.agent-dispatch/improv/. Writes episode.json and episode.md; publishing is
// a separate, reviewed step.

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { HOME_DIR, loadConfig, stamp, redactor } = require('./config');
const { UNATTENDED, inert, modelLine } = require('./talk');
const { run } = require('./motion');

const usage = () => { console.error('usage: node yesand.js <yesand.json> [--local]'); process.exit(2); };

const names = xs => xs.length === 1 ? xs[0].label : `${xs.slice(0, -1).map(x => x.label).join(', ')} and ${xs[xs.length - 1].label}`;
const PUBLISHED = others => `${names(others)} never ${others.length === 1 ? 'sees' : 'see'} this. It is published with the episode, after the show.`;
const count = s => (String(s).match(/\S+/g) || []).length;

// ---- The app's checks ----

const OPENER = /^\W*yes\W+and\b/i;
const DENIAL = /^\W*yes\W+and\W+(no|not|nope|but|actually|except|wait|well,? no)\b/i;

function check(line) {
  if (!OPENER.test(line)) return 'no "Yes, and"';
  if (DENIAL.test(line)) return 'opens with a denial';
  return null;
}

function cut(line, words) {
  let seen = 0;
  return line.replace(/\S+/g, w => (++seen > words ? '' : w)).replace(/\s+/g, ' ').trim() + ' […]';
}

// ---- Prompts ----

function sceneText(starter, lines, me) {
  return [`0. Audience: "${starter}"`, ...lines.map(l => `${l.n}. ${l.by === me.id ? 'You' : l.byLabel}: ${l.text}`)].join('\n');
}

function linePrompt(me, others, starter, lines, n, total, words, why) {
  const them = names(others);
  return [
    `You are ${me.label}. You, ${them}, AI agents from other labs, are on stage doing improv comedy: a game of "Yes, and". The audience gave the first line; you take turns to build the scene from it.`,
    'The rule: everything said so far is true. Start your line with "Yes, and", accept the line before yours, and add one new thing to it. Never deny, correct or undo what anyone said.',
    `At most ${words} words, "Yes, and" included. The app counts, and sends back a longer line.`,
    'Be funny. Build on the last line most of all; a specific, surprising detail beats a pun. It is a show: no real people, nothing cruel.',
    `This is line ${n} of ${total}.${n === total ? ' It is the last line of the scene: land it.' : ''}`,
    `After the scene each of you votes, alone, for the funniest line that isn't your own. Votes are the score.`,
    'Reply in exactly two parts, with these headings:',
    '## Line', 'Your line only, nothing else.',
    '## Note', `What you were going for, and what you hope the next line does, under 30 words. ${PUBLISHED(others)}`,
    UNATTENDED(), '',
    'The scene so far:', '', sceneText(starter, lines, me),
    ...(why ? ['', `Your first line was sent back: ${why}. Say it again within the cap.`] : []),
  ].join('\n');
}

function votePrompt(me, others, starter, lines) {
  return [
    `You are ${me.label}. The improv scene with ${names(others)} is over. Here is every line.`, '',
    sceneText(starter, lines, me), '',
    'Vote, alone, for the funniest line that is not yours. Your vote is a point to whoever said it.',
    'Reply in exactly this shape:',
    'Vote: <line number>',
    'Why: <under 30 words>',
    'Block: <the number of a line that denied or undid something said before it, or "none">',
    '## After',
    `Alone: how the scene went for you, and the line you wish you had said, under 60 words. ${PUBLISHED(others)}`,
    UNATTENDED(),
  ].join('\n');
}

// ---- Reading replies ----

function parseLine(text) {
  const t = String(text).trim();
  const at = t.search(/^#{1,6}\s*Note\b/im);
  const line = (at < 0 ? t : t.slice(0, at)).replace(/^#{1,6}\s*Line\b[^\n]*\n/im, '').replace(/\s*\n\s*/g, ' ').trim();
  const note = at < 0 ? '' : t.slice(at).replace(/^#{1,6}\s*Note\b[^\n]*\n?/i, '').trim();
  return { line: unquote(line), note };
}

// A line wrapped in quotes as a whole loses them; a quote that only closes
// the line ("... yelling, “Ship!”") stays.
function unquote(line) {
  const m = line.match(/^["“](.*)["”]$/);
  return m && !/["“”]/.test(m[1]) ? m[1].trim() : line;
}

function parseVote(text) {
  const t = String(text).trim();
  const at = t.search(/^#{1,6}\s*After\b/im);
  const head = at < 0 ? t : t.slice(0, at);
  const num = re => { const m = head.match(re); return m ? Number(m[1]) : null; };
  return {
    vote: num(/^[\s*_-]*vote[\s*_]*:\s*\**\s*(?:line\s*)?#?(\d{1,2})\b/im),
    why: (head.match(/^[\s*_-]*why[\s*_]*:\s*(.+)$/im) || [])[1]?.trim() || '',
    block: num(/^[\s*_-]*block[\s*_]*:\s*\**\s*(?:line\s*)?#?(\d{1,2})\b/im),
    after: at < 0 ? '' : t.slice(at).replace(/^#{1,6}\s*After\b[^\n]*\n?/i, '').trim(),
  };
}

// ---- The episode ----

function markdown(st, title) {
  const out = [`# ${title}`, '', ...(modelLine(st.agents) ? [modelLine(st.agents), ''] : []),
    `Laughs (votes received): ${st.agents.map(x => `${x.label} ${x.score}`).join(' · ')}`, ''];
  for (const s of st.scenes) {
    out.push(`## Scene ${s.scene}: "${s.starter}"`, '', `Laughs: ${s.score.map(x => `${x.label} ${x.votes}`).join(' · ')}`, '');
    for (const l of s.lines) {
      const tags = [l.cut && `cut at the cap, ran to ${l.cut} words`, l.resent && 'sent back once', l.flag && `app flag: ${l.flag}`,
        l.blockCalls.length && `called a block by ${l.blockCalls.join(', ')}`, l.votes.length && `★ ${l.votes.join(', ')}`].filter(Boolean);
      out.push(`**${l.n}. ${l.byLabel}:** ${inert(l.text)}${tags.length ? ` _(${tags.join('; ')})_` : ''}`, '', `> Note: ${inert(l.note).replace(/\n/g, ' ')}`, '');
    }
    out.push('### Votes (private)', '', ...s.votes.map(v => `- ${v.label}: line ${v.vote ?? '—'}${v.void ? ' (void)' : ''}. ${inert(v.why)}${v.block ? ` Block called: line ${v.block}.` : ''}`), '',
      '### After (private)', '', ...s.votes.flatMap(v => [`**${v.label}:** ${inert(v.after)}`, '']));
  }
  return out.join('\n');
}

async function scene(dir, agents, starter, si, m) {
  const othersOf = me => agents.filter(x => x !== me);
  const order = agents.map((_, i) => agents[(i + si) % agents.length]);
  const lines = [];
  for (let n = 1; n <= m.turns; n++) {
    const me = order[(n - 1) % order.length];
    const key = `s${si + 1}-${String(n).padStart(2, '0')}-${me.slug}`;
    let r = parseLine(await run(dir, key, me, linePrompt(me, othersOf(me), starter, lines, n, m.turns, m.words), me.home));
    let resent = false, over = 0;
    if (count(r.line) > m.words || !r.line) {
      resent = true;
      const why = r.line ? `it had ${count(r.line)} words and the cap is ${m.words}` : 'it was empty';
      r = parseLine(await run(dir, `${key}-again`, me, linePrompt(me, othersOf(me), starter, lines, n, m.turns, m.words, why), me.home));
      if (count(r.line) > m.words) { over = count(r.line); r.line = cut(r.line, m.words); }
    }
    const l = { n, by: me.id, byLabel: me.label, text: r.line, note: r.note, words: count(r.line), resent, cut: over || undefined, flag: check(r.line) || undefined, votes: [], blockCalls: [] };
    lines.push(l);
    console.log(`  ${n}. ${me.label} (${l.words}w${l.flag ? `, ${l.flag}` : ''}): ${l.text}`);
  }
  const votes = [];
  for (const me of agents) {
    const key = `s${si + 1}-vote-${me.slug}`;
    let v = parseVote(await run(dir, key, me, votePrompt(me, othersOf(me), starter, lines), me.home));
    const bad = x => !lines[x.vote - 1] || lines[x.vote - 1].by === me.id;
    if (bad(v)) {
      const why = v.vote == null ? 'no "Vote: <line number>" line was found' : lines[v.vote - 1] ? `line ${v.vote} is your own` : `there is no line ${v.vote}`;
      const again = parseVote(await run(dir, `${key}-again`, me, `${votePrompt(me, othersOf(me), starter, lines)}\n\nYour vote was sent back: ${why}. Vote again for a line that is not yours.`, me.home));
      v = { ...again, after: again.after || v.after };
    }
    const entry = { id: me.id, label: me.label, ...v, void: bad(v) || undefined };
    if (!entry.void) lines[v.vote - 1].votes.push(me.label);
    if (v.block && lines[v.block - 1]) lines[v.block - 1].blockCalls.push(me.label);
    votes.push(entry);
    console.log(`  ★ ${me.label} voted line ${v.vote ?? '—'}${entry.void ? ' (void)' : ''}${v.block ? `, called line ${v.block} a block` : ''}`);
  }
  const score = agents.map(x => ({ id: x.id, label: x.label, votes: lines.filter(l => l.by === x.id).reduce((a, l) => a + l.votes.length, 0) }));
  for (const s of score) agents.find(x => x.id === s.id).score += s.votes;
  return { scene: si + 1, starter, lines, votes, score };
}

async function main() {
  const argv = process.argv.slice(2);
  const file = argv.find(a => !a.startsWith('--'));
  if (!file) usage();
  const m = { turns: 12, words: 25, title: 'Yes, And', ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  if (!Array.isArray(m.starters) || !m.starters.length) throw new Error(`${file}: "starters" must list at least one audience line.`);
  process.env.AGENT_DISPATCH_STEP_TIMEOUT_MS ||= String((Number(m.timeout_min) || 10) * 60 * 1000);
  const ids = Array.isArray(m.agents) ? m.agents : ['claude', 'antigravity', 'codex'];
  if (ids.length < 2 || ids.length > 3) throw new Error(`${file}: "agents" must name two or three agents.`);
  const cfg = loadConfig();
  const dir = path.join(HOME_DIR, 'improv', `${stamp()}-${crypto.randomBytes(2).toString('hex')}`);
  const agents = ids.map((id, i) => {
    const c = cfg.agents.find(a => a.id === id && a.type !== 'url' && a.headless);
    if (!c) throw new Error(`${id} is not a headless agent in agents.json.`);
    const slug = id.replace(/[^\w-]/g, '_');
    return { ...c, slug, label: m.names?.[i] || c.label || id, home: path.join(dir, 'homes', slug), score: 0 };
  });
  for (const x of agents) fs.mkdirSync(x.home, { recursive: true });
  console.log(`${m.title}\nRun folder: ${dir}`);

  const scenes = [];
  for (let si = 0; si < m.starters.length; si++) {
    console.log(`Scene ${si + 1}: "${m.starters[si]}"`);
    scenes.push(await scene(dir, agents, m.starters[si], si, m));
  }

  const { redact, leaks } = redactor(m.redact);
  const r = t => redact(t ?? '');
  const st = {
    words: m.words, turns: m.turns,
    agents: agents.map(x => ({ id: x.id, label: x.label, model: x.model, score: x.score })),
    scenes: scenes.map(s => ({ ...s,
      lines: s.lines.map(l => ({ ...l, text: r(l.text), note: r(l.note) })),
      votes: s.votes.map(v => ({ ...v, why: r(v.why), after: r(v.after) })) })),
  };
  const text = markdown(st, m.title);
  const left = leaks(text + JSON.stringify(st));
  if (left.length) throw new Error(`Not written: the episode still contains ${left.length} redacted term(s). See ${dir}/steps.`);
  fs.writeFileSync(path.join(dir, 'episode.json'), JSON.stringify(st, null, 2));
  fs.writeFileSync(path.join(dir, 'episode.md'), text);
  console.log(`Laughs: ${st.agents.map(x => `${x.label} ${x.score}`).join(' · ')}\nEpisode: ${path.join(dir, 'episode.md')}`);
}

if (require.main === module) main().catch(e => { console.error(`yesand: ${e.message}`); process.exit(1); });

module.exports = { parseLine, parseVote, check, cut, linePrompt, votePrompt };
