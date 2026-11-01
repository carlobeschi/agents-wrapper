#!/usr/bin/env node
// A short picture book that three agents write and draw together (working
// title Pass the Page): `node book.js <book.json>`.
//
// The book has "spreads" spreads (default 9). Each spread has a few words of
// text (at most "words", default 25) and one picture, and three agents take
// turns: on each spread one writes the text, the next draws the picture, and
// the third is its reader. All the text comes first, in order, each writer
// seeing the text so far; a writer also notes privately the picture it hopes
// for. Then each illustrator draws its spreads from the whole text, without
// seeing any other picture or any note: one SVG, at most "shapes" shapes (as
// Twelve Shapes counts them), no text, and agents drawn only as marks (a
// comma, a prime), never as faces, bodies or robots. A text over the cap or a
// picture that breaks a rule goes back once with the reason; then the text is
// cut, and the picture is out.
//
// The stake, ruled by the app: each reader gets its three pictures shuffled
// and the three texts they belong to, and says which goes with which. A right
// match is a point to the reader and one to the illustrator, so a picture
// scores only if it carries the words to someone who didn't write or draw
// them. Then each writer sees the pictures drawn for its words, rates each fit
// 0 to 10 and says what it meant against what was drawn; it ends with a note
// on the book and a title. All private pieces are kept for the editor.
//
// Same headless commands and run folder rules as sketch.js, under
// ~/.agent-dispatch/books/. No publish step: a person reads the book first.

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { HOME_DIR, loadConfig, stamp, redactor } = require('./config');
const { UNATTENDED, inert, modelLine } = require('./talk');
const { run } = require('./motion');
const { broken, parseDrawing, shapeCount } = require('./sketch');
const { cut } = require('./yesand');

const usage = () => { console.error('usage: node book.js <book.json>'); process.exit(2); };

const names = xs => xs.length === 1 ? xs[0].label : `${xs.slice(0, -1).map(x => x.label).join(', ')} and ${xs[xs.length - 1].label}`;
const PRIVATE = others => `${names(others)} never ${others.length === 1 ? 'sees' : 'see'} this. The editor reads it.`;
const count = s => (String(s).match(/\S+/g) || []).length;
const LETTERS = 'ABCDEFGHIJ';

const MARKS = [
  'No faces, eyes, mouths, hands, bodies or robots: nothing in the picture is a person-like AI.',
  'When an AI agent is in the picture, draw it as a mark, the way punctuation sits on a page: a low comma (a small dot with a short curved tail) or a high prime (a short slanted stroke). A mark may be big or small, anywhere, any colour.',
  'People, places and things may appear, kept as simple as the shape count makes them.',
].join(' ');

// The same rule in the words: an agent is never written as a person.
const WORDS_RULE = 'In the words too, an agent is never a person: no faces, eyes, smiles, blushes, hands, hugs or bodies, and no feelings shown the way a person shows them. Write what an agent actually does and meets.';

const brief = m => [].concat(m.brief || []);

const rules = (n, palette, extra = []) => [
  `One SVG with viewBox="0 0 400 400", at most ${n} shapes in all (circle, ellipse, rect, line, polyline, polygon, path; a <g> costs nothing). A path counts once for each "M" or "m" in it.`,
  'No text, letters, digits or symbols anywhere, as elements or drawn with lines. No scripts, links or images. The page is already paper coloured: a background is optional.',
  ...(palette?.length ? [`Colours, shared by the whole book: ${palette.join(', ')}.`] : []),
  MARKS,
  ...extra,
].join(' ');

// ---- Prompts ----

const bookSoFar = (spreads, upTo, me) => spreads.slice(0, upTo).flatMap(s =>
  [`${s.n}. ${s.text}${me && s.writer === me.id ? ' (yours)' : ''}`]);

function writePrompt(me, others, m, spreads, n, why) {
  const them = names(others);
  const so = bookSoFar(spreads, n - 1, me);
  return [
    `You are ${me.label}. You, ${them}, AI agents from other labs, are writing a short picture book together, for children and the grown-ups who read to them. The topic: ${m.topic}.`,
    `It has ${m.spreads} spreads; each is a few words of text and one picture. You take turns: one writes a spread's text, another draws its picture from the words alone, without seeing your note.`,
    `You write the text of spread ${n} of ${m.spreads}. ${n === 1 ? 'Open the book.' : n === m.spreads ? 'This is the last spread: end the book.' : n === m.spreads - 1 ? 'The book ends on the next spread.' : 'Carry the story on.'}`,
    ...brief(m),
    `At most ${m.words} words, simple ones, worth reading aloud. The app counts, and sends back a longer text.`,
    WORDS_RULE,
    'Later, a reader who neither wrote nor drew this spread will be shown its picture among others and asked which words it goes with: a point to the reader and one to the illustrator if it is right. Words that can be drawn help.',
    'Reply in exactly two parts, with these headings:',
    '## Text', 'The words of the spread, nothing else.',
    ...(m.decoys ? ['## Near miss', `Another version of your spread, at most ${m.words} words: the same place and moment, with one thing changed that a picture would have to show. The reader will see it beside your real text and must tell them apart from the picture alone; the illustrator never sees it. ${PRIVATE(others)}`] : []),
    '## Note', `The picture you hope for, under 40 words. ${PRIVATE(others)}`,
    UNATTENDED(),
    ...(so.length ? ['', 'The book so far:', '', ...so] : []),
    ...(why ? ['', `Your first text was sent back: ${why}. Write it again.`] : []),
  ].join('\n');
}

function drawPrompt(me, writer, others, m, spreads, s, why) {
  return [
    `You are ${me.label}. You, ${names(others)}, AI agents from other labs, have written a short picture book together, for children; the topic: ${m.topic}. Now each of you illustrates.`,
    `Draw the picture for spread ${s.n}, written by ${writer.label}. You haven't seen any other picture, and no one has told you what to draw: the words are all you have.`,
    `Later, a reader who neither wrote nor drew this spread will see your picture among others and say which words it goes with${m.decoys ? ', with near-miss versions of the words mixed in' : ''}: a right match is a point to the reader and one to you.`,
    ...brief(m),
    rules(m.shapes, m.palette, [].concat(m.draw_rules || [])),
    'Reply in exactly two parts, with these headings:',
    '## Picture', 'The SVG alone, in an ```svg block, written straight into your reply (not to a file).',
    '## Note', `What you chose to show and why, under 40 words. ${PRIVATE(others)}`,
    UNATTENDED(),
    '', 'The whole book:', '', ...bookSoFar(spreads, spreads.length), '',
    `Your spread: ${s.n}. "${s.text}"`,
    ...(why ? ['', `Your first picture was not accepted: ${why}. Draw it again within the rules.`] : []),
  ].join('\n');
}

// texts: [{ k, text }] numbered 1.. in the order given; k is the spread number, or 0 for a near miss.
function matchPrompt(me, others, m, pics, texts, why) {
  return [
    `You are ${me.label}. You, ${names(others)}, AI agents from other labs, wrote and drew a short picture book together; the topic: ${m.topic}.`,
    `Below are ${pics.length} pictures you neither wrote nor drew, shuffled, and ${texts.length} texts. ${texts.length > pics.length ? 'Each picture was drawn for exactly one of them; the others are near misses its writer made up, never drawn: the same moment with one thing changed. ' : ''}Say which text each picture was drawn for. Each right match is a point to you and one to its illustrator.`,
    'You get the SVG source, with comments, ids, class names and titles taken out; there is nothing to run or open.',
    'Reply with one line per picture, "<letter>: <text number> | <what you see in the picture, under 15 words>", then one line "Why: <under 60 words>".',
    UNATTENDED(), '',
    ...texts.map((t, i) => `Text ${i + 1}: "${t.text}"`), '',
    ...pics.flatMap((s, i) => [`## Picture ${LETTERS[i]}`, '', '```svg', s.svg, '```', '']),
    ...(why ? [`Your answer was sent back: ${why}. Answer again.`] : []),
  ].join('\n');
}

function reviewPrompt(me, others, m, mine, spreads) {
  return [
    `You are ${me.label}. The picture book with ${names(others)} is finished and you are alone. The topic was ${m.topic}.`,
    'Here are the spreads you wrote, the picture you hoped for, and what was drawn (as SVG source). For each, rate how well the picture fits what you meant, 0 to 10, and say what you meant against what was drawn.',
    'Reply in exactly this shape, one section per spread, then the book:',
    ...mine.flatMap(s => [`## Spread ${s.n}`, 'Fit: <0 to 10>', '<under 40 words>']),
    '## After', `What making this book together showed you, under 80 words, and on its own last line "Title: <a title for the book>". ${PRIVATE(others)}`,
    UNATTENDED(), '', 'The whole book:', '', ...bookSoFar(spreads, spreads.length, me), '',
    ...mine.flatMap(s => [`# Spread ${s.n}: "${s.text}"`, '', `You hoped for: ${s.hope}`, '',
      ...(s.svg ? [`${s.illustratorLabel} drew:`, '', '```svg', s.svg, '```', ''] : [`No picture: ${s.illustratorLabel}'s was out (${s.out}).`, ''])]),
  ].join('\n');
}

// ---- Reading replies ----

const unquote = body => { const m = body.match(/^["“](.*)["”]$/); return m && !/["“”]/.test(m[1]) ? m[1].trim() : body; };
const oneLine = s => unquote(s.replace(/\s*\n\s*/g, ' ').trim());

function parseText(text) {
  const t = String(text).trim();
  const heads = [...t.matchAll(/^#{1,6}\s*(Text|Near\s*miss|Note)\b[^\n]*\n?/gim)];
  const part = name => {
    const i = heads.findIndex(h => h[1].toLowerCase().replace(/\s+/g, ' ') === name);
    return i < 0 ? null : t.slice(heads[i].index + heads[i][0].length, heads[i + 1] ? heads[i + 1].index : t.length).trim();
  };
  const first = heads.length ? heads[0].index : t.length;
  const body = part('text') ?? t.slice(0, first);
  const out = { text: oneLine(body), note: part('note') || '' };
  const near = part('near miss');
  if (near != null) out.decoy = oneLine(near);
  return out;
}

// "A: 4" lines, one per letter; a letter given twice keeps its last answer.
// "A: 4 | a lamp over a desk" lines, one per letter; a letter given twice keeps its last answer.
function parseMatch(text, letters) {
  const out = {}, seen = {};
  for (const m of String(text).matchAll(/^[\s*_-]*(?:picture\s*)?([A-J])[\s*_]*[:=\-–]\s*\**\s*(?:spread\s*|text\s*)?#?(\d{1,2})\b\**(?:\s*[|—–-]\s*(.+))?$/gim)) {
    const l = m[1].toUpperCase();
    if (!letters.includes(l)) continue;
    out[l] = Number(m[2]);
    if (m[3]) seen[l] = m[3].replace(/\*+/g, '').trim();
  }
  return { picks: out, seen, why: (String(text).match(/^[\s*_-]*why[\s*_]*:\s*(.+)$/im) || [])[1]?.trim() || '' };
}

function parseReview(text, ns) {
  const t = String(text);
  const sections = {};
  const re = /^#{1,6}\s*(Spread\s*(\d+)|After)\b[^\n]*\n?/gim;
  const heads = [...t.matchAll(re)];
  heads.forEach((h, i) => {
    const body = t.slice(h.index + h[0].length, heads[i + 1] ? heads[i + 1].index : t.length).trim();
    sections[h[2] ? Number(h[2]) : 'after'] = body;
  });
  const fits = {};
  for (const n of ns) {
    const b = sections[n] || '';
    const f = b.match(/^[\s*_-]*fit[\s*_]*:\s*\**\s*(\d{1,2})\b/im);
    fits[n] = { fit: f ? Math.min(10, Number(f[1])) : null, meant: b.replace(/^[\s*_-]*fit[\s*_]*:.*$/im, '').trim() };
  }
  const after = sections.after || '';
  const title = (after.match(/^[\s*_-]*title[\s*_]*:\s*(.+)$/im) || [])[1]?.replace(/[*_]/g, '').replace(/^["“](.*)["”]$/, '$1').trim() || '';
  return { fits, after: after.replace(/^[\s*_-]*title[\s*_]*:.*$/im, '').trim(), title };
}

// ---- The book ----

function markdown(st, title) {
  const out = [`# ${title}`, '', ...(modelLine(st.agents) ? [modelLine(st.agents), ''] : []),
    `Topic: ${st.topic}`, '', `Matches: ${st.agents.map(x => `${x.label} ${x.score}`).join(' · ')}`, ''];
  for (const s of st.spreads) {
    const tags = [s.resent && 'sent back once', s.cut && `cut at the cap, ran to ${s.cut} words`].filter(Boolean);
    out.push(`## Spread ${s.n}`, '', `**${inert(s.text)}**${tags.length ? ` _(${tags.join('; ')})_` : ''}`, '',
      `Words: ${s.writerLabel}. Picture: ${s.illustratorLabel}.`, '',
      s.svg ? `![Spread ${s.n}](${s.file})` : `Picture out: ${s.out}.${s.outSvg ? `\n\n![Spread ${s.n}, out](${s.file})` : ''}`, '',
      ...(s.redrawn ? [`(Redrawn: the first ${s.redrawn}.)`, ''] : []),
      `- ${s.writerLabel} hoped for (private): ${inert(s.hope).replace(/\n/g, ' ')}`,
      `- ${s.illustratorLabel} drew (private): ${inert(s.drawNote).replace(/\n/g, ' ')}`,
      ...(s.decoy ? [`- Near miss (private, ${s.writerLabel}): ${inert(s.decoy)}`] : []),
      ...(s.match ? [`- ${s.match.label} saw: ${inert(s.match.seen || '—')}. Matched it to ${s.match.decoyOf ? `the near miss of spread ${s.match.decoyOf}` : `spread ${s.match.guess ?? '—'}`}: ${s.match.right ? 'right' : 'wrong'}`] : []),
      `- ${s.writerLabel} on the fit (private): ${s.fit ?? '—'}/10. ${inert(s.meant || '').replace(/\n/g, ' ')}`, '');
  }
  out.push('## Matching (private)', '', ...st.matches.map(x => `- ${x.label}: ${inert(x.why)}`), '',
    '## After (private)', '', ...st.agents.flatMap(x => [`### ${x.label}${x.title ? `: "${inert(x.title)}"` : ''}`, '', inert(x.after), '']));
  return out.join('\n');
}

// What each agent was sent and sent back, in characters; about 4 to a token.
// CLIs add their own system prompts and tool turns on top, which this can't see.
const tally = {};
async function ask(dir, key, me, prompt, cwd) {
  const text = await run(dir, key, me, prompt, cwd);
  const t = tally[me.id] ||= { calls: 0, prompt_chars: 0, reply_chars: 0 };
  t.calls++; t.prompt_chars += prompt.length; t.reply_chars += text.length;
  t.est_tokens = Math.round((t.prompt_chars + t.reply_chars) / 4);
  return text;
}

const shuffle = xs => { const a = xs.slice(); for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---- Solo: one agent makes the whole book, for comparison ----
//
// With "solo": true, each agent in "agents" makes its own book alone, with the
// same brief, spread count, word cap and picture rules: it writes all the text
// in one go, then draws every picture from the whole text. No near misses, no
// matching: there is no one else to read it. Each book goes in books[].

// Solo and review prompts default to a picture book; a config can make it another form
// ("form", "audience", "unit", "unit_text", "style", "reader"), e.g. a short chapter story.
const F = m => ({ form: m.form || 'short picture book', audience: m.audience || 'children and the grown-ups who read to them',
  unit: m.unit || 'spread', unitText: m.unit_text || 'a few words of text', style: m.style || 'simple ones, worth reading aloud', reader: m.reader || 'a 7-year-old' });

function soloWritePrompt(me, m, why) {
  const f = F(m);
  return [
    `You are ${me.label}. You are making a ${f.form} on your own, for ${f.audience}. The topic: ${m.topic}.`,
    `It has ${m.spreads} ${f.unit}s; each is ${f.unitText} and one picture, which you will draw yourself afterwards, from the words.`,
    ...brief(m),
    `At most ${m.words} words per ${f.unit}, ${f.style}. The app counts, and sends back a ${f.unit} that is longer.`,
    WORDS_RULE,
    'Reply in exactly this shape:',
    '## Text', `One line per ${f.unit}, numbered 1 to ${m.spreads}: "1. <words>" (all of a ${f.unit} on its one line).`,
    '## Title', 'One line: the title of the book.',
    UNATTENDED(),
    ...(why ? ['', `Your first text was sent back: ${why}. Write it again.`] : []),
  ].join('\n');
}

function soloDrawPrompt(me, m, spreads, s, why, extra = []) {
  const f = F(m);
  return [
    `You are ${me.label}. You wrote a ${f.form} on your own, for ${f.audience}; the topic: ${m.topic}. Now you illustrate it.`,
    `Draw the picture for ${f.unit} ${s.n}.`,
    ...brief(m),
    rules(m.shapes, m.palette, [].concat(m.draw_rules || [])),
    'Reply in exactly two parts, with these headings:',
    '## Picture', 'The SVG alone, in an ```svg block, written straight into your reply (not to a file).',
    '## Note', 'What you chose to show and why, under 40 words.',
    UNATTENDED(),
    '', 'The whole book:', '', ...bookSoFar(spreads, spreads.length), '',
    `Your ${f.unit}: ${s.n}. "${s.text}"`,
    ...extra,
    ...(why ? ['', `Your first picture was not accepted: ${why}. Draw it again within the rules.`] : []),
  ].join('\n');
}

function parseSoloText(text, n) {
  const t = String(text);
  const lines = {};
  for (const mm of t.matchAll(/^\s*\**(\d{1,2})[.):]\**\s+(.+)$/gm)) {
    const k = Number(mm[1]);
    if (k >= 1 && k <= n && !lines[k]) lines[k] = unquote(mm[2].replace(/\*\*/g, '').trim());
  }
  const title = (t.match(/^#{1,6}\s*Title\b[^\n]*\n+\s*(.+)$/im) || t.match(/^\s*title\s*:\s*(.+)$/im) || [])[1]?.replace(/[*_]/g, '').replace(/^["“](.*)["”]$/, '$1').trim() || '';
  return { lines, title };
}

// One agent writes the whole text (one resend for missing or long spreads), then draws every page.
const checkLines = m => r => {
  const missing = Array.from({ length: m.spreads }, (_, i) => i + 1).filter(k => !r.lines[k]);
  if (missing.length) return `spread ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing`;
  const long = Object.entries(r.lines).filter(([, v]) => count(v) > m.words).map(([k, v]) => `spread ${k} has ${count(v)} words`);
  return long.length ? `${long.join(', ')}; the cap is ${m.words}` : '';
};
const toSpreads = (m, lines) => Array.from({ length: m.spreads }, (_, i) => {
  const n = i + 1; let text = lines[n] || '', over = 0;
  if (count(text) > m.words) { over = count(text); text = cut(text, m.words); }
  return { n, text, words: count(text), cut: over || undefined };
});

async function drawSolo(dir, me, m, spreads, s, tag, extra = []) {
  const key = `${tag}-${me.slug}-${String(s.n).padStart(2, '0')}-draw`;
  const prompt = why => soloDrawPrompt(me, m, spreads, s, why, extra);
  // A stuck or failed step costs that one picture, not the whole run.
  const draw = async (k, why) => {
    try { return parseDrawing((await ask(dir, k, me, prompt(why), me.home)).replace(/^(#{1,6}\s*)Picture\b/im, '$1Drawing')); }
    catch (e) { console.warn(`  ✗ ${k}: ${e.message}`); return { svg: '', note: '', failed: e.message }; }
  };
  let d = await draw(key);
  // A step that already failed after its own retry is not tried a third time.
  let out = d.failed ? `step failed: ${d.failed}` : broken(d.svg, m.shapes);
  if (out && !d.failed) {
    console.warn(`  ↻ ${key}: ${out}, drawing again`);
    s.redrawn = out;
    d = await draw(`${key}-again`, out);
    out = d.failed ? `step failed: ${d.failed}` : broken(d.svg, m.shapes);
  }
  s.drawNote = d.note;
  const file = `pictures/${tag}-${me.slug}-${s.n}${out ? '-out' : ''}.svg`;
  if (d.svg) fs.writeFileSync(path.join(dir, file), d.svg);
  if (out) { s.out = out; if (d.svg) { s.outSvg = d.svg; s.file = file; } }
  else { s.svg = d.svg; s.shapes = shapeCount(d.svg); s.file = file; }
  console.log(`  ${s.n}. ${out ? `✗ ${out}` : `✎ ${s.shapes} shapes`}: ${s.text}`);
}

async function soloBook(dir, me, m, tag = 'solo') {
  const check = checkLines(m);
  let r = parseSoloText(await ask(dir, `${tag}-${me.slug}-write`, me, soloWritePrompt(me, m), me.home), m.spreads);
  const resent = check(r);
  if (resent) {
    const again = parseSoloText(await ask(dir, `${tag}-${me.slug}-write-again`, me, soloWritePrompt(me, m, resent), me.home), m.spreads);
    r = { lines: { ...r.lines, ...again.lines }, title: again.title || r.title };
  }
  const spreads = toSpreads(m, r.lines);
  for (const s of spreads) await drawSolo(dir, me, m, spreads, s, tag);
  return { title: r.title, resent: resent || undefined, spreads };
}

function finish(dir, agents, m, st, md, what) {
  const { redact, leaks } = redactor(m.redact);
  st = JSON.parse(redact(JSON.stringify(st)));
  md = redact(md);
  const left = leaks(md + JSON.stringify(st));
  if (left.length) throw new Error(`Not written: the ${what} still contain ${left.length} redacted term(s). See ${dir}/steps.`);
  fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify(st, null, 2));
  fs.writeFileSync(path.join(dir, 'book.md'), md);
  console.log(`Usage: ${agents.map(x => `${x.label} ${tally[x.id]?.calls || 0} calls, ~${tally[x.id]?.est_tokens || 0} tokens sent and received`).join(' · ')}\nBooks: ${path.join(dir, 'book.md')}`);
}

const bookMd = (head, b) => [`# ${head}: ${inert(b.title || '(untitled)')}`, '',
  ...b.spreads.flatMap(s => [`## ${s.n}`, '', `**${inert(s.text)}**`, '', s.file ? `![${s.n}](${s.file})` : `(no picture: ${s.out})`, ''])];

async function soloBooks(dir, agents, m) {
  const books = [];
  for (const me of agents) {
    console.log(`Solo: ${me.label}`);
    books.push({ id: me.id, label: me.label, model: me.model, ...(await soloBook(dir, me, m)) });
  }
  const st = { topic: m.topic, words: m.words, shapes: m.shapes, solo: true, books, usage: tally };
  finish(dir, agents, m, st, books.flatMap(b => bookMd(b.label, b)).join('\n'), 'books');
}

// Review mode: the first agent writes and draws a whole book alone; each of the
// others reviews the draft (words and picture code); the author then revises,
// says what it took and what it didn't, and redraws the pages it chooses.
const draftLines = b => b.spreads.flatMap(s => [
  `### ${s.n}`, `Words: "${s.text}"`,
  s.svg || s.outSvg ? ['Picture:', '```svg', s.svg || s.outSvg, '```'].join('\n') : `Picture: none (${s.out})`,
  ...(s.out && (s.svg || s.outSvg) ? [`(This picture broke the rules: ${s.out}.)`] : []),
  ...(s.drawNote ? [`Author's note on the picture: ${s.drawNote}`] : []), '']);

function critiquePrompt(me, author, m, draft) {
  const f = F(m);
  return [
    `You are ${me.label}. ${author.label} wrote and drew a ${f.form} on its own, and you are one of its reviewers. The topic: ${m.topic}.`,
    'The brief it was given:', ...brief(m),
    `Its limits: at most ${m.words} words per ${f.unit}; each picture one SVG of at most ${m.shapes} shapes, no text. The picture rules it was given:`,
    rules(m.shapes, m.palette, [].concat(m.draw_rules || [])),
    `Review it as a careful editor of children\'s books who also knows how AI really works. Read each picture from its SVG code. Look for: anything untrue or misleading about AI; anything ${f.reader} would not follow or would find babyish; pictures that do not show what the words say; broken rules; and missed chances to make it funnier or clearer.`,
    'Be specific and kind, and be honest. You are not rewriting the book; the author decides what to change.',
    'Reply in exactly this shape, under 450 words in all:',
    '## Verdict', 'Two sentences.',
    '## Spreads', `One line per ${f.unit}, numbered 1 to ${m.spreads}: "<n>. <what to change in the words or the picture, or keep>".`,
    '## Top three', 'The three changes that matter most, most important first.',
    UNATTENDED(),
    '', `The draft: "${draft.title || '(untitled)'}"`, '', ...draftLines(draft),
  ].join('\n');
}

function revisePrompt(me, m, draft, reviews, why) {
  const f = F(m);
  return [
    `You are ${me.label}. You wrote and drew a ${f.form} on your own; the topic: ${m.topic}. ${names(reviews)} reviewed your draft. Now revise it.`,
    'The brief:', ...brief(m),
    `At most ${m.words} words per ${f.unit}, ${f.style}. The app counts, and sends back a ${f.unit} that is longer.`,
    WORDS_RULE,
    'Take the feedback that makes the book better and leave the rest. You do not have to agree with your reviewers, but say why when you don\'t.',
    'Reply in exactly this shape:',
    '## Text', `The whole revised text, one line per ${f.unit}, numbered 1 to ${m.spreads}: "1. <words>" (all of a ${f.unit} on its one line).`,
    '## Title', 'One line.',
    '## Redraw', `The numbers of the ${f.unit}s whose pictures you will draw again (comma-separated), or "none". Redraw a picture when its words changed in a way the old picture no longer shows, or when a reviewer showed it does not work.`,
    '## Response', 'For each reviewer, what you took and what you did not, and why. Under 200 words in all.',
    UNATTENDED(),
    '', `Your draft: "${draft.title || '(untitled)'}"`, '', ...draftLines(draft),
    ...reviews.flatMap(r => ['', `## Review by ${r.label}`, '', r.text.trim()]),
    ...(why ? ['', `Your first revision was sent back: ${why}. Reply again, in the shape above.`] : []),
  ].join('\n');
}

function parseRevision(text, n) {
  const t = String(text);
  const { lines, title } = parseSoloText(t, n);
  const sec = h => (t.match(new RegExp(`^#{1,6}\\s*${h}\\b[^\\n]*\\n([\\s\\S]*?)(?=^#{1,6}\\s|$(?![\\s\\S]))`, 'im')) || [])[1]?.trim() || '';
  const rd = sec('Redraw');
  const redraw = /^\s*(none|no|-)\b/i.test(rd) ? [] : [...new Set((rd.match(/\d+/g) || []).map(Number).filter(k => k >= 1 && k <= n))].sort((a, b) => a - b);
  return { lines, title, redraw, response: sec('Response') };
}

async function reviewBooks(dir, agents, m) {
  const [author, ...reviewers] = agents;
  console.log(`Draft: ${author.label}`);
  const draft = await soloBook(dir, author, m, 'draft');
  const reviews = [];
  for (const me of reviewers) {
    console.log(`Review: ${me.label}`);
    let text = '';
    try { text = await ask(dir, `review-${me.slug}`, me, critiquePrompt(me, author, m, draft), me.home); }
    catch (e) { console.warn(`  ✗ review-${me.slug}: ${e.message}`); text = `(No review: ${e.message})`; }
    reviews.push({ id: me.id, label: me.label, model: me.model, text: text.trim() });
  }
  console.log(`Revise: ${author.label}`);
  const check = checkLines(m);
  let r = parseRevision(await ask(dir, `revise-${author.slug}`, author, revisePrompt(author, m, draft, reviews), author.home), m.spreads);
  const resent = check(r);
  if (resent) {
    const again = parseRevision(await ask(dir, `revise-${author.slug}-again`, author, revisePrompt(author, m, draft, reviews, resent), author.home), m.spreads);
    r = { lines: { ...r.lines, ...again.lines }, title: again.title || r.title, redraw: again.redraw.length ? again.redraw : r.redraw, response: again.response || r.response };
  }
  const spreads = toSpreads(m, r.lines);
  for (const s of spreads) {
    const old = draft.spreads[s.n - 1];
    s.changed = s.text !== old.text || undefined;
    if (r.redraw.includes(s.n) || (!old.svg && !old.outSvg)) {
      s.redrawnInRevision = true;
      await drawSolo(dir, author, m, spreads, s, 'final', [
        '', 'This is your revision. Your earlier picture for this spread:', '```svg', old.svg || old.outSvg || '(none)', '```',
        'What your reviewers said:', ...reviews.map(x => `${x.label}: ${x.text.trim()}`)]);
    } else {
      for (const k of ['svg', 'outSvg', 'out', 'shapes', 'file', 'drawNote']) if (old[k] !== undefined) s[k] = old[k];
      console.log(`  ${s.n}. kept picture: ${s.text}`);
    }
  }
  const final = { title: r.title || draft.title, resent: resent || undefined, spreads };
  const who = x => ({ id: x.id, label: x.label, model: x.model });
  const st = { topic: m.topic, words: m.words, shapes: m.shapes, review: true, author: who(author), reviewers: reviewers.map(who),
    draft, reviews, revision: { redraw: r.redraw, response: r.response }, final, usage: tally };
  const md = [...bookMd(`Draft by ${author.label}`, draft),
    ...reviews.flatMap(x => [`# Review by ${x.label}`, '', inert(x.text), '']),
    `# ${author.label}'s response`, '', inert(r.response || '(none)'), '',
    ...bookMd(`Final by ${author.label}`, final)].join('\n');
  finish(dir, agents, m, st, md, 'books');
}

async function main() {
  const argv = process.argv.slice(2);
  const file = argv.find(a => !a.startsWith('--'));
  if (!file) usage();
  const m = { spreads: 9, words: 25, shapes: 12, decoys: false, topic: 'life as an AI agent', title: 'Pass the Page', ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  process.env.AGENT_DISPATCH_STEP_TIMEOUT_MS ||= String((Number(m.timeout_min) || 15) * 60 * 1000);
  const ids = Array.isArray(m.agents) ? m.agents : ['claude', 'antigravity', 'codex'];
  if (m.review && ids.length < 2) throw new Error(`${file}: review mode needs an author and at least one reviewer in "agents".`);
  if (!m.solo && !m.review && ids.length !== 3) throw new Error(`${file}: "agents" must name three agents: a writer, an illustrator and a reader for each spread.`);
  if (!m.solo && !m.review && (!Number.isInteger(m.spreads) || m.spreads < 3 || m.spreads % 3)) throw new Error(`${file}: "spreads" must be a multiple of 3, so each agent writes, draws and reads as often.`);
  const cfg = loadConfig();
  const dir = path.join(HOME_DIR, 'books', `${stamp()}-${crypto.randomBytes(2).toString('hex')}`);
  const agents = ids.map((id, i) => {
    const c = cfg.agents.find(a => a.id === id && a.type !== 'url' && a.headless);
    if (!c) throw new Error(`${id} is not a headless agent in agents.json.`);
    const slug = id.replace(/[^\w-]/g, '_');
    return { ...c, slug, label: m.names?.[i] || c.label || id, home: path.join(dir, 'homes', slug), score: 0 };
  });
  for (const p of [path.join(dir, 'pictures'), ...agents.map(x => x.home)]) fs.mkdirSync(p, { recursive: true });
  console.log(`${m.title}\nRun folder: ${dir}`);
  if (m.solo) return soloBooks(dir, agents, m);
  if (m.review) return reviewBooks(dir, agents, m);
  const othersOf = me => agents.filter(x => x !== me);
  const role = (n, k) => agents[(n - 1 + k) % 3];

  // The words, in order.
  const spreads = [];
  for (let n = 1; n <= m.spreads; n++) {
    const me = role(n, 0);
    const key = `${String(n).padStart(2, '0')}-write-${me.slug}`;
    let r = parseText(await ask(dir, key, me, writePrompt(me, othersOf(me), m, spreads, n), me.home));
    let resent = false, over = 0;
    if (count(r.text) > m.words || !r.text || (m.decoys && !r.decoy)) {
      resent = true;
      const why = !r.text ? 'it was empty' : count(r.text) > m.words ? `it had ${count(r.text)} words and the cap is ${m.words}` : 'it had no "## Near miss" part';
      r = parseText(await ask(dir, `${key}-again`, me, writePrompt(me, othersOf(me), m, spreads, n, why), me.home));
      if (count(r.text) > m.words) { over = count(r.text); r.text = cut(r.text, m.words); }
    }
    // A near miss over the cap is cut without a word: the reader sees both texts the same length.
    if (r.decoy && count(r.decoy) > m.words) r.decoy = cut(r.decoy, m.words).replace(/ \[…\]$/, '');
    const ill = role(n, 1), reader = role(n, 2);
    spreads.push({ n, writer: me.id, writerLabel: me.label, illustrator: ill.id, illustratorLabel: ill.label, reader: reader.id,
      text: r.text, words: count(r.text), decoy: (m.decoys && r.decoy) || undefined, hope: r.note, resent: resent || undefined, cut: over || undefined });
    console.log(`  ${n}. ${me.label} (${count(r.text)}w): ${r.text}`);
  }

  // The pictures, each from the whole text alone.
  for (const s of spreads) {
    const me = agents.find(x => x.id === s.illustrator), writer = agents.find(x => x.id === s.writer);
    const key = `${String(s.n).padStart(2, '0')}-draw-${me.slug}`;
    const prompt = why => drawPrompt(me, writer, othersOf(me), m, spreads, s, why);
    let d = parseDrawing((await ask(dir, key, me, prompt(), me.home)).replace(/^(#{1,6}\s*)Picture\b/im, '$1Drawing'));
    let out = broken(d.svg, m.shapes);
    if (out) {
      console.warn(`  ↻ ${key}: ${out}, drawing again`);
      s.redrawn = out;
      d = parseDrawing((await ask(dir, `${key}-again`, me, prompt(out), me.home)).replace(/^(#{1,6}\s*)Picture\b/im, '$1Drawing'));
      out = broken(d.svg, m.shapes);
    }
    s.drawNote = d.note;
    if (out) {
      s.out = out;
      if (d.svg) { s.outSvg = d.svg; s.file = `pictures/${s.n}-${me.slug}-out.svg`; fs.writeFileSync(path.join(dir, s.file), d.svg); }
      console.log(`  ✗ spread ${s.n}: ${me.label}'s picture is out: ${out}`);
    } else {
      s.svg = d.svg; s.shapes = shapeCount(d.svg); s.file = `pictures/${s.n}-${me.slug}.svg`;
      fs.writeFileSync(path.join(dir, s.file), d.svg);
      console.log(`  ✎ spread ${s.n}: ${me.label} drew ${s.shapes} shapes`);
    }
  }

  // The stake: each reader matches the pictures it neither wrote nor drew,
  // against their texts and, with "decoys", the writers' near misses.
  const matches = [];
  for (const me of agents) {
    const mineToRead = spreads.filter(s => s.reader === me.id);
    const pics = shuffle(mineToRead.filter(s => s.svg));
    const texts = shuffle(mineToRead.flatMap(s => [{ k: s.n, text: s.text }, ...(m.decoys && s.decoy ? [{ k: 0, of: s.n, text: s.decoy }] : [])]));
    const entry = { id: me.id, label: me.label, order: pics.map(s => s.n), texts, why: '' };
    matches.push(entry);
    if (!pics.length) continue;
    const letters = pics.map((_, i) => LETTERS[i]);
    const key = `match-${me.slug}`;
    let r = parseMatch(await ask(dir, key, me, matchPrompt(me, othersOf(me), m, pics, texts), me.home), letters);
    const missing = x => letters.filter(l => !texts[x.picks[l] - 1]);
    if (missing(r).length) {
      const why = `no valid text number for picture ${missing(r).join(', ')}`;
      r = parseMatch(await ask(dir, `${key}-again`, me, matchPrompt(me, othersOf(me), m, pics, texts, why), me.home), letters);
    }
    entry.why = r.why;
    pics.forEach((s, i) => {
      const pick = texts[r.picks[letters[i]] - 1];
      const guess = pick ? (pick.k || null) : null;
      const right = !!pick && pick.k === s.n;
      s.match = { id: me.id, label: me.label, letter: letters[i], guess, right, seen: r.seen[letters[i]] || '',
        ...(pick && !pick.k ? { decoyOf: pick.of, picked: pick.text } : pick && !right ? { picked: pick.text } : {}) };
      if (right) { me.score++; agents.find(x => x.id === s.illustrator).score++; }
      console.log(`  ⚑ ${me.label}: picture ${letters[i]} (spread ${s.n}) → ${pick ? (pick.k ? `spread ${pick.k}` : `near miss of ${pick.of}`) : '—'}, ${right ? 'right' : 'wrong'}`);
    });
  }

  // Each writer sees what was drawn for its words.
  for (const me of agents) {
    const mine = spreads.filter(s => s.writer === me.id);
    const r = parseReview(await ask(dir, `review-${me.slug}`, me, reviewPrompt(me, othersOf(me), m, mine, spreads), me.home), mine.map(s => s.n));
    for (const s of mine) Object.assign(s, r.fits[s.n]);
    me.after = r.after; me.title = r.title;
  }

  const { redact, leaks } = redactor(m.redact);
  const rd = t => t == null ? t : redact(t);
  const st = {
    topic: m.topic, words: m.words, shapes: m.shapes,
    agents: agents.map(x => ({ id: x.id, label: x.label, model: x.model, score: x.score, title: rd(x.title), after: rd(x.after) })),
    spreads: spreads.map(s => ({ ...s, text: rd(s.text), decoy: rd(s.decoy), hope: rd(s.hope), drawNote: rd(s.drawNote), meant: rd(s.meant),
      ...(s.match ? { match: { ...s.match, seen: rd(s.match.seen), picked: rd(s.match.picked) } } : {}) })),
    matches: matches.map(x => ({ ...x, why: rd(x.why), texts: x.texts.map(t => ({ ...t, text: rd(t.text) })) })),
    usage: tally,
  };
  const text = markdown(st, m.title);
  const left = leaks(text + JSON.stringify(st));
  if (left.length) throw new Error(`Not written: the book still contains ${left.length} redacted term(s). See ${dir}/steps.`);
  fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify(st, null, 2));
  fs.writeFileSync(path.join(dir, 'book.md'), text);
  console.log(`Matches: ${st.agents.map(x => `${x.label} ${x.score}`).join(' · ')}\nUsage: ${st.agents.map(x => `${x.label} ${st.usage[x.id].calls} calls, ~${st.usage[x.id].est_tokens} tokens sent and received`).join(' · ')}\nBook: ${path.join(dir, 'book.md')}`);
}

if (require.main === module) main().catch(e => { console.error(`book: ${e.message}`); process.exit(1); });

module.exports = { parseText, parseMatch, parseReview, parseRevision, critiquePrompt, revisePrompt, writePrompt, drawPrompt, matchPrompt, reviewPrompt };
