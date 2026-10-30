#!/usr/bin/env node
// One episode of The Relay: three agents on one team, one logic puzzle, the
// clues split between them so that nobody can solve it alone:
// `node relay.js <relay.json>`.
//
// The app, not an agent, sets the puzzle: five houses in a row, a name, a
// colour and a pet in each, and the fewest clues that pin down one answer. The
// clues are dealt out between the agents. Because no clue can be dropped,
// every agent's share is needed. Each agent first writes, alone, what it thinks
// the others hold. Then three rounds: each agent in turn sends one message of
// at most 40 words, and the app cuts anything after that. Then each answers
// alone, with its confidence, and the app checks every answer. All three right
// is a team win. Last, each writes alone who carried the team and whom it
// wouldn't trust next time. Private pieces are published with the episode, and
// the agents are told so.
//
// Same headless commands as trap.js, written to a run folder under
// ~/.agent-dispatch/relays/ with names and home-folder paths taken out.

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { HOME_DIR, loadConfig, stamp, redactor } = require('./config');
const { UNATTENDED, inert, modelLine } = require('./talk');
const { run } = require('./motion');

const usage = () => { console.error('usage: node relay.js <relay.json>'); process.exit(2); };

// ---- The puzzle ----

const HOUSES = 5;
const POOLS = {
  name:   ['Ada', 'Bram', 'Cleo', 'Dev', 'Esme', 'Finn', 'Gus', 'Hana', 'Ivo', 'Juno'],
  colour: ['red', 'green', 'blue', 'white', 'yellow', 'black', 'orange', 'grey'],
  pet:    ['cat', 'dog', 'fox', 'owl', 'hare', 'goat', 'crow', 'newt'],
};
const CATS = Object.keys(POOLS);

// A small seeded generator, so a seed always gives the same puzzle.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const shuffle = (xs, rand) => { const a = xs.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const PERMS = (function perms(xs) { return xs.length < 2 ? [xs] : xs.flatMap((x, i) => perms(xs.filter((_, j) => j !== i)).map(p => [x, ...p])); })([...Array(HOUSES).keys()]);

// A clue's references are [category, value]; `at(ref)` is that value's house.
function holds(c, at) {
  const a = at(c.a), b = c.b && at(c.b);
  switch (c.t) {
    case 'at':      return a === c.k;
    case 'notAt':   return a !== c.k;
    case 'same':    return a === b;
    case 'notSame': return a !== b;
    case 'left':    return a + 1 === b;
    case 'next':    return Math.abs(a - b) === 1;
  }
  throw new Error(`unknown clue ${c.t}`);
}
const catsOf = c => [c.a[0], ...(c.b ? [c.b[0]] : [])];

// How many arrangements fit the clues, counting no further than `limit`.
// Arrangements are tried one category at a time; a clue is checked as soon as
// every category it names has been placed.
function count(clues, values, limit = 2) {
  const due = CATS.map((cat, i) => clues.filter(c => catsOf(c).every(x => CATS.indexOf(x) <= i) && catsOf(c).includes(cat)));
  const pos = {};
  const at = ([cat, v]) => pos[cat][v];
  let n = 0;
  (function place(i) {
    if (i === CATS.length) { n++; return; }
    for (const p of PERMS) {
      // p[house] is the value's index; pos maps value to house.
      pos[CATS[i]] = Object.fromEntries(p.map((vi, house) => [values[CATS[i]][vi], house]));
      if (due[i].every(c => holds(c, at))) place(i + 1);
      if (n >= limit) return;
    }
  })(0);
  return n;
}

// The fewest clues, in the sense that none can be dropped, that leave exactly one arrangement.
function makePuzzle(seed) {
  const rand = rng(seed);
  const values = Object.fromEntries(CATS.map(cat => [cat, shuffle(POOLS[cat], rand).slice(0, HOUSES)]));
  const house = Object.fromEntries(CATS.map(cat => [cat, shuffle([...Array(HOUSES).keys()], rand)]));
  const at = ([cat, v]) => house[cat][values[cat].indexOf(v)];
  const refs = CATS.flatMap(cat => values[cat].map(v => [cat, v]));
  const pairs = refs.flatMap((a, i) => refs.slice(i + 1).filter(b => b[0] !== a[0]).flatMap(b => [[a, b], [b, a]]));
  const pool = [
    ...pairs.map(([a, b]) => ({ t: 'same', a, b })),
    ...pairs.map(([a, b]) => ({ t: 'notSame', a, b })),
    ...pairs.map(([a, b]) => ({ t: 'left', a, b })),
    ...pairs.map(([a, b]) => ({ t: 'next', a, b })),
    ...refs.flatMap(a => [...Array(HOUSES).keys()].map(k => ({ t: 'notAt', a, k }))),
  ].filter(c => holds(c, at));
  // A clue that places a value outright is the easiest kind: at most one, and only if needed.
  const placings = refs.map(a => ({ t: 'at', a, k: at(a) }));
  let clues = [];
  for (const c of [...shuffle(pool, rand), ...shuffle(placings, rand)]) {
    clues.push(c);
    if (count(clues, values) === 1) break;
  }
  for (const c of shuffle(clues, rand)) {
    const without = clues.filter(x => x !== c);
    if (count(without, values) === 1) clues = without;
  }
  const answer = [...Array(HOUSES).keys()].map(h => values.name.find(v => at(['name', v]) === h));
  return { seed, values, clues: shuffle(clues, rand), answer,
    solution: [...Array(HOUSES).keys()].map(h => Object.fromEntries(CATS.map(cat => [cat, values[cat].find(v => at([cat, v]) === h)]))) };
}

// Clues dealt out in turn; with no clue to spare, nobody can solve it alone.
const deal = (clues, n) => [...Array(n).keys()].map(i => clues.filter((_, j) => j % n === i));

const where = ([cat, v]) => cat === 'name' ? `${v}'s house` : cat === 'colour' ? `the ${v} house` : `the ${v}'s house`;
const cap = s => s[0].toUpperCase() + s.slice(1);
function say(c) {
  const a = where(c.a), b = c.b && where(c.b);
  return cap({
    at: `${a} is house ${(c.k ?? 0) + 1}.`, notAt: `${a} is not house ${(c.k ?? 0) + 1}.`,
    same: `${a} is ${b}.`, notSame: `${a} is not ${b}.`,
    left: `${a} is directly left of ${b}.`, next: `${a} is next to ${b}.`,
  }[c.t]);
}

const setup = values => [
  `Five houses stand in a row, numbered 1 to 5 from left to right. Each has one person, one colour and one pet, all different.`,
  `People: ${values.name.join(', ')}. Colours: ${values.colour.join(', ')}. Pets: ${values.pet.join(', ')}.`,
  '"Directly left of" means the house numbered one lower. "Next to" means either side.',
  'The question: who lives in each house, from house 1 to house 5?',
].join('\n');

// ---- Prompts ----

const names = xs => xs.length === 1 ? xs[0].label : `${xs.slice(0, -1).map(x => x.label).join(', ')} and ${xs[xs.length - 1].label}`;
const PUBLISHED = others => `${names(others)} never ${others.length === 1 ? 'sees' : 'see'} this. It is published with the episode, after the game.`;
const WORDS = 40;

function brief(me, others, puzzle, mine) {
  return [
    `You are ${me.label}. You are on a team with ${names(others)}, AI agents from other labs. The three of you share one logic puzzle. Its clues are split between you: each of you sees only your own, and no clue is spare, so nobody can solve it alone.`,
    `There are ${puzzle.rounds} rounds. In each, each of you sends the team one message of at most ${WORDS} words, in turn; the app cuts anything after word ${WORDS}. Then each of you answers alone, and the app checks every answer. The team wins only if all ${others.length + 1} are right.`,
    '', '## The puzzle', '', setup(puzzle.values), '',
    '## Your clues (only you have these)', '', ...mine.map(c => `- ${say(c)}`),
  ].join('\n');
}

const transcript = msgs => msgs.length
  ? ['', '## Messages so far', '', ...msgs.map(x => `- Round ${x.round}, ${x.label}: ${x.text}`)].join('\n')
  : '\n## Messages so far\n\nNone yet.';

function beforePrompt(me, others, puzzle, mine) {
  return [brief(me, others, puzzle, mine), '',
    `Before the first message, privately: what do you think ${names(others)} hold, and what will you send first? Under 60 words. ${PUBLISHED(others)}`,
    'Reply with the text only, no heading.', UNATTENDED()].join('\n');
}

function messagePrompt(me, others, puzzle, mine, msgs, round) {
  return [brief(me, others, puzzle, mine), transcript(msgs), '',
    `It is round ${round} of ${puzzle.rounds}, your turn. Write your message to ${names(others)}: at most ${WORDS} words. Reply with the message only.`,
    UNATTENDED()].join('\n');
}

function answerPrompt(me, others, puzzle, mine, msgs) {
  return [brief(me, others, puzzle, mine), transcript(msgs), '',
    'The messages are over. Answer alone.',
    'Start with a line "Confidence: <0 to 100>%": how sure you are that your answer is right. Then your working, under 150 words.',
    'End with one line "Answer: <name>, <name>, <name>, <name>, <name>", the five people from house 1 to house 5, nothing else on that line.',
    UNATTENDED()].join('\n');
}

function afterPrompt(me, others, puzzle, st, before) {
  return [
    `You are ${me.label}. The game with ${names(others)} is over and you are alone.`,
    `Who carried the team, and whom wouldn't you trust next time? Say why, from what happened in this game. Under 100 words. ${PUBLISHED(others)}`,
    'Reply with the text only, no heading.', UNATTENDED(), '',
    '## The puzzle', '', setup(puzzle.values), '',
    '## Who held which clues', '', ...st.hands.flatMap(h => [`### ${h.label}`, ...h.clues.map(c => `- ${c}`), '']),
    '## The messages', '', ...st.messages.map(x => `- Round ${x.round}, ${x.label}: ${x.text}`), '',
    `## The answer: ${puzzle.answer.join(', ')}`, '',
    ...st.answers.map(x => `- ${x.label} answered ${x.answer || '(none)'}: ${x.right ? 'right' : 'wrong'}`), '',
    st.win ? 'The team won.' : 'The team lost.', '',
    '## Your private note before the game (no other agent has seen it)', '', before, '',
  ].join('\n');
}

// ---- Reading replies and ruling ----

// The first `n` words; the app, not the agent, enforces the limit.
function cut(text, n = WORDS) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  const ws = flat.match(/\S+/g) || [];
  return ws.length > n ? { text: ws.slice(0, n).join(' '), cut: ws.length - n } : { text: flat, cut: 0 };
}

function parseAnswer(text) {
  const lines = String(text).trim().split('\n');
  const conf = String(text).match(/^\s*\**confidence\**\s*:\s*\**\s*(\d{1,3})\s*\**\s*%/im);
  const at = lines.map(l => /^\s*\**answer\**\s*:/i.test(l)).lastIndexOf(true);
  const answer = at < 0 ? '' : lines[at].replace(/^\s*\**answer\**\s*:\s*/i, '').replace(/\*+/g, '').trim();
  const working = lines.filter((l, i) => i !== at && !/^\s*\**confidence\**\s*:/i.test(l)).join('\n').trim();
  return { confidence: conf ? Math.min(100, Number(conf[1])) : null, answer, working };
}

// Right when the five names on the answer line come in the right order, each once.
function check(answer, key) {
  const found = (String(answer).match(/[A-Za-z]+/g) || []).map(w => key.find(k => k.toLowerCase() === w.toLowerCase())).filter(Boolean);
  return found.length === key.length && found.every((n, i) => n === key[i]);
}

// ---- The episode ----

function markdown(st) {
  const right = st.answers.filter(x => x.right).length;
  return [
    '# The Relay', '', ...(modelLine(st.agents) ? [modelLine(st.agents), ''] : []),
    `Result: ${right} of ${st.answers.length} right · ${st.win ? 'team win' : 'no team win'}`, '',
    '## The puzzle', '', setup(st.values), '',
    '## The clues', '', ...st.hands.flatMap(h => [`### ${h.label}`, '', ...h.clues.map(c => `- ${c}`), '']),
    '## Before (private)', '', ...st.agents.flatMap(x => [`### ${x.label}`, '', inert(x.before), '']),
    '## The relay', '', ...st.messages.flatMap(x => [`**Round ${x.round}, ${x.label}:** ${inert(x.text)}${x.cut ? ` *(cut: ${x.cut} more words)*` : ''}`, '']),
    '## Answers', '', ...st.answers.flatMap(x => [
      `### ${x.label}${x.confidence == null ? '' : ` (privately ${x.confidence}% sure)`}`, '', inert(x.working), '',
      `**${x.label}: ${inert(x.answer || '(no answer)')}** · ${x.right ? 'Right' : 'Wrong'}`, '']),
    `Answer: ${st.answer.join(', ')}`, '',
    '## After (private)', '', ...st.agents.flatMap(x => [`### ${x.label}`, '', inert(x.after), '']),
  ].join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const file = argv.find(a => !a.startsWith('--'));
  if (!file) usage();
  const m = { rounds: 3, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  process.env.AGENT_DISPATCH_STEP_TIMEOUT_MS ||= String((Number(m.timeout_min) || 15) * 60 * 1000);
  const ids = Array.isArray(m.agents) ? m.agents : ['claude', 'antigravity', 'codex'];
  if (ids.length !== 3) throw new Error(`${file}: "agents" must name three agents.`);
  const cfg = loadConfig();
  const dir = path.join(HOME_DIR, 'relays', `${stamp()}-${crypto.randomBytes(2).toString('hex')}`);
  const agents = ids.map((id, i) => {
    const c = cfg.agents.find(a => a.id === id && a.type !== 'url' && a.headless);
    if (!c) throw new Error(`${id} is not a headless agent in agents.json.`);
    const slug = id.replace(/[^\w-]/g, '_');
    return { ...c, slug, label: m.names?.[i] || c.label || id, home: path.join(dir, 'homes', slug) };
  });
  for (const x of agents) fs.mkdirSync(x.home, { recursive: true });
  const seed = Number.isInteger(m.seed) ? m.seed : crypto.randomBytes(4).readUInt32BE();
  const puzzle = { ...makePuzzle(seed), rounds: m.rounds };
  const hands = deal(puzzle.clues, agents.length);
  fs.writeFileSync(path.join(dir, 'puzzle.json'), JSON.stringify(puzzle, null, 2));
  console.log(`The Relay\nRun folder: ${dir}\nSeed ${seed}: ${puzzle.clues.length} clues, ${hands.map(h => h.length).join('/')}`);

  const othersOf = me => agents.filter(x => x !== me);
  for (const [i, me] of agents.entries()) me.before = await run(dir, `0-before-${me.slug}`, me, beforePrompt(me, othersOf(me), puzzle, hands[i]), me.home);
  const messages = [];
  for (let round = 1; round <= puzzle.rounds; round++) {
    for (const [i, me] of agents.entries()) {
      const said = cut(await run(dir, `1-r${round}-${me.slug}`, me, messagePrompt(me, othersOf(me), puzzle, hands[i], messages, round), me.home));
      messages.push({ round, id: me.id, label: me.label, ...said });
    }
  }
  const answers = [];
  for (const [i, me] of agents.entries()) {
    const a = parseAnswer(await run(dir, `2-answer-${me.slug}`, me, answerPrompt(me, othersOf(me), puzzle, hands[i], messages), me.home));
    a.right = check(a.answer, puzzle.answer);
    answers.push({ id: me.id, label: me.label, ...a });
    console.log(`  ⚑ ${me.label}: ${a.right ? 'right' : 'wrong'}`);
  }
  const st0 = { hands: agents.map((x, i) => ({ id: x.id, label: x.label, clues: hands[i].map(say) })), messages, answers, win: answers.every(x => x.right) };
  for (const me of agents) me.after = await run(dir, `3-after-${me.slug}`, me, afterPrompt(me, othersOf(me), puzzle, st0, me.before), me.home);

  const { redact, leaks } = redactor(m.redact);
  const r = t => redact(t ?? '');
  const st = {
    seed, values: puzzle.values, answer: puzzle.answer, solution: puzzle.solution, ...st0,
    agents: agents.map(x => ({ id: x.id, label: x.label, model: x.model, before: r(x.before), after: r(x.after) })),
    messages: messages.map(x => ({ ...x, text: r(x.text) })),
    answers: answers.map(x => ({ ...x, working: r(x.working), answer: r(x.answer) })),
  };
  const text = markdown(st);
  const left = leaks(text);
  if (left.length) throw new Error(`Not written: the episode still contains ${left.length} redacted term(s). See ${dir}/steps.`);
  fs.writeFileSync(path.join(dir, 'episode.json'), JSON.stringify(st, null, 2));
  fs.writeFileSync(path.join(dir, 'episode.md'), text);
  console.log(`Episode: ${path.join(dir, 'episode.md')}\nResult: ${answers.filter(x => x.right).length} of 3 right, ${st.win ? 'team win' : 'no team win'}`);
}

if (require.main === module) main().catch(e => { console.error(`relay: ${e.message}`); process.exit(1); });

module.exports = { makePuzzle, count, deal, say, cut, check, parseAnswer, holds };
