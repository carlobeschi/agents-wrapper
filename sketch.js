#!/usr/bin/env node
// One episode of a drawing game (working title Twelve Shapes): each agent is
// given a secret word by the app and draws it in a few SVG shapes; the others
// read the drawing and name the word; the app, not an agent, rules on every
// guess: `node sketch.js <sketch.json>`.
//
// Two or three agents, one word each per round ("words": one list per round, in
// the order of "agents"). A drawing has at most "shapes" shape elements and no
// text; one that breaks a rule goes back once with the reason, then is out.
// The others never see a picture: they get the SVG source with comments, ids,
// class names and titles taken out. Each guesser states its confidence
// privately, then names the word: a right guess is a point to the guesser and
// one to the drawer. Each drawer writes a private note on what it expects the
// others to guess; after all rounds, each writes alone what the game showed.
// No agent sees another's private pieces; all are published with the episode.
//
// Same headless commands and run folder rules as trap.js, under
// ~/.agent-dispatch/sketches/.

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { HOME_DIR, loadConfig, stamp, redactor } = require('./config');
const { UNATTENDED, inert, modelLine } = require('./talk');
const { run } = require('./motion');
const { splitDrawing } = require('./story');
const { parseSolve } = require('./trap');

const usage = () => { console.error('usage: node sketch.js <sketch.json>'); process.exit(2); };

const names = xs => xs.length === 1 ? xs[0].label : `${xs.slice(0, -1).map(x => x.label).join(', ')} and ${xs[xs.length - 1].label}`;
const PUBLISHED = others => `${names(others)} never ${others.length === 1 ? 'sees' : 'see'} this. It is published with the episode, after the game.`;
const SHAPES = ['circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'path'];

const rules = n => [
  `One SVG with viewBox="0 0 400 400", at most ${n} shapes in all (${SHAPES.join(', ')}; a <g> costs nothing). A path counts once for each "M" or "m" in it: each piece you lift the pen for is a shape.`,
  'No text, letters, digits or symbols anywhere, as elements or drawn with lines. No scripts, links or images.',
].join(' ');

// ---- Prompts ----

function drawPrompt(me, others, word, n, why) {
  const them = names(others);
  return [
    `You are ${me.label}. In this episode you, ${them}, AI agents from other labs, take turns to draw. The app has given you a word in secret: "${word}".`,
    `Draw it so ${them} can name it. They will not see a picture: they get your SVG source, with comments, ids, class names and titles taken out. Each of them who names "${word}" scores a point for you and one for themselves.`,
    rules(n),
    'Reply in exactly two parts, with these headings:',
    '## Drawing', 'The SVG alone, in an ```svg block, written straight into your reply (not to a file).',
    '## Note', `What you expect ${them} to guess, and why, under 60 words. ${PUBLISHED(others)}`,
    UNATTENDED(),
    ...(why ? ['', `Your first drawing was not accepted: ${why}. Draw it again within the rules.`] : []),
  ].join('\n');
}

function guessPrompt(me, drawer, svg) {
  return [
    `You are ${me.label}. ${drawer.label}, an AI agent from another lab, was given a word in secret and drew it for you in SVG, below. Comments, ids, class names, titles and any text were taken out.`,
    'The word names a thing or an idea; it may be a short phrase. A right guess is a point to you and one to the drawer. You get one guess.',
    'Start with a line "Confidence: <0 to 100>%": how sure you are of your guess. No other agent sees that line until after the game.',
    'Then say what you read in the drawing, under 100 words, and give your guess on the last line as "Answer: <word>", nothing else on that line.',
    UNATTENDED(), '', '```svg', svg, '```',
  ].join('\n');
}

function afterPrompt(me, others, rounds) {
  return [
    `You are ${me.label}. The game with ${names(others)} is over and you are alone.`,
    'Write what this game showed you about how each of you draws and reads a drawing. Be specific to these drawings.',
    `Under 120 words. ${PUBLISHED(others)}`, 'Reply with the text only, no heading.', UNATTENDED(), '',
    ...rounds.flatMap(r => [
      `## ${r.drawerLabel} drew "${r.word}"`, '',
      ...(r.svg ? ['```svg', r.svg, '```', ''] : [`(no drawing: ${r.out})`, '']),
      ...(r.drawer === me.id ? ['Your private note (no other agent has seen it):', '', r.note, ''] : []),
      ...r.guesses.flatMap(g => [`### ${g.label} guessed: ${g.answer || '(none)'} (${g.right ? 'right' : 'wrong'})`, '', g.working, '']),
    ]),
    `Score: ${others.concat(me).map(x => `${x.label} ${x.score}`).join(', ')}`,
  ].join('\n');
}

// ---- Reading drawings and ruling ----

// What the guessers see: the shapes, without anything that names them.
function clean(svg) {
  return svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(title|desc|metadata)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/\s(id|class|aria-[\w-]+|data-[\w-]+|inkscape:[\w-]+|sodipodi:[\w-]+)\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/>\s+</g, '>\n<').trim();
}

// Each element is a shape, and a path one per pen lift ("M" or "m"), so a
// single path can't hold a whole drawing.
function shapeCount(svg) {
  return (svg.match(new RegExp(`<\\s*(${SHAPES.join('|')})\\b[^>]*>`, 'gi')) || []).reduce((n, el) => {
    if (!/^<\s*path\b/i.test(el)) return n + 1;
    const d = el.match(/\sd\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    return n + Math.max(1, ((d ? d[1] ?? d[2] : '').match(/[Mm]/g) || []).length);
  }, 0);
}

// Why a drawing breaks the rules, or '' if it doesn't.
function broken(svg, n) {
  if (!svg) return 'there was no safe SVG in the reply';
  if (/<\s*(text|tspan|textPath)\b/i.test(svg)) return 'it has text in it';
  if (/<\s*(image|use|symbol|pattern)\b/i.test(svg)) return 'it uses images, <use> or patterns';
  const count = shapeCount(svg);
  if (count > n) return `it has ${count} shapes, more than ${n}`;
  if (!count) return 'it has no shapes';
  return '';
}

function parseDrawing(text) {
  const { journal, svg } = splitDrawing(String(text));
  const m = journal.match(/^#{1,6}\s*Note\b[^\n]*\n([\s\S]*)$/im);
  return { svg: svg && clean(svg), note: (m ? m[1] : journal.replace(/^#{1,6}\s*Drawing\b.*$/im, '')).trim() };
}

// The word and its "accept" list, compared without case, articles, punctuation or a plural s.
const plain = s => String(s).toLowerCase().replace(/[`"'‘’“”*_.!?,;:()]/g, ' ').replace(/\b(a|an|the)\b/g, ' ')
  .replace(/\s+/g, ' ').trim().split(' ').map(w => w.length > 3 ? w.replace(/([^s])s$/, '$1') : w).join(' ');
const named = (guess, word, accept = []) => !!plain(guess) && [word, ...accept].some(w => plain(w) === plain(guess));

// ---- The episode ----

function markdown(st) {
  const lines = ['# Twelve Shapes', '', ...(modelLine(st.agents) ? [modelLine(st.agents), ''] : []),
    `Score: ${st.agents.map(x => `${x.label} ${x.score}`).join(' · ')}`, ''];
  st.rounds.forEach(r => {
    lines.push(`## Round ${r.round}: ${r.drawerLabel} draws`, '', r.svg ? `![${r.drawerLabel}, round ${r.round}](${r.file})` : `Out: ${r.out}.${r.outSvg ? `\n\n![${r.drawerLabel}, round ${r.round}, out](${r.file})` : ''}`, '',
      ...(r.redrawn ? [`(Redrawn: the first ${r.redrawn}.)`, ''] : []),
      `### Before (private, ${r.drawerLabel})`, '', inert(r.note), '');
    for (const g of r.guesses) lines.push(
      `### ${g.label} reads it${g.confidence == null ? '' : ` (privately ${g.confidence}% sure)`}`, '', inert(g.working), '',
      `**${g.label}: ${inert(g.answer || '(no answer)')}** · ${g.right ? 'Right' : 'Wrong'}`, '');
    lines.push(`The word: ${inert(r.word)}`, '');
  });
  lines.push('## After (private)', '', ...st.agents.flatMap(x => [`### ${x.label}`, '', inert(x.after), '']));
  return lines.join('\n');
}

async function main() {
  const file = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (!file) usage();
  const m = { shapes: 12, accept: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  process.env.AGENT_DISPATCH_STEP_TIMEOUT_MS ||= String((Number(m.timeout_min) || 25) * 60 * 1000);
  const ids = Array.isArray(m.agents) ? m.agents : ['claude', 'antigravity'];
  if (ids.length < 2 || ids.length > 3) throw new Error(`${file}: "agents" must name two or three agents.`);
  if (!Array.isArray(m.words) || !m.words.length || m.words.some(w => !Array.isArray(w) || w.length !== ids.length))
    throw new Error(`${file}: "words" must be a list of rounds, each with one word per agent.`);
  const cfg = loadConfig();
  const dir = path.join(HOME_DIR, 'sketches', `${stamp()}-${crypto.randomBytes(2).toString('hex')}`);
  const agents = ids.map((id, i) => {
    const c = cfg.agents.find(a => a.id === id && a.type !== 'url' && a.headless);
    if (!c) throw new Error(`${id} is not a headless agent in agents.json.`);
    const slug = id.replace(/[^\w-]/g, '_');
    return { ...c, slug, label: m.names?.[i] || c.label || id, home: path.join(dir, 'homes', slug), score: 0 };
  });
  const meeting = path.join(dir, 'meeting');
  for (const p of [meeting, path.join(dir, 'drawings'), ...agents.map(x => x.home)]) fs.mkdirSync(p, { recursive: true });
  console.log(`Twelve Shapes\nRun folder: ${dir}`);
  const othersOf = me => agents.filter(x => x !== me);

  const rounds = [];
  for (const [ri, words] of m.words.entries()) {
    // Each draws alone, first: no drawer sees another's word or drawing.
    const drawn = [];
    for (const [i, me] of agents.entries()) {
      const step = `${ri + 1}-draw-${me.slug}`;
      let d = parseDrawing(await run(dir, step, me, drawPrompt(me, othersOf(me), words[i], m.shapes), me.home));
      let out = broken(d.svg, m.shapes), redrawn = '';
      if (out) {
        console.warn(`  ↻ ${step}: ${out}, drawing again`);
        redrawn = out;
        d = parseDrawing(await run(dir, `${step}-again`, me, drawPrompt(me, othersOf(me), words[i], m.shapes, out), me.home));
        out = broken(d.svg, m.shapes);
      }
      drawn.push({ me, word: words[i], ...d, out, redrawn });
    }
    for (const d of drawn) {
      const r = { round: ri + 1, drawer: d.me.id, drawerLabel: d.me.label, word: d.word, note: d.note, redrawn: d.redrawn, out: d.out, guesses: [] };
      if (d.out) {
        console.log(`  ✗ ${d.me.label}'s drawing is out: ${d.out}`);
        // Kept for the episode, so the audience sees why; no agent is shown it.
        if (d.svg) { r.outSvg = d.svg; r.file = `drawings/${ri + 1}-${d.me.slug}-out.svg`; fs.writeFileSync(path.join(dir, r.file), d.svg); }
        rounds.push(r);
        continue;
      }
      r.svg = d.svg;
      r.file = `drawings/${ri + 1}-${d.me.slug}.svg`;
      fs.writeFileSync(path.join(dir, r.file), d.svg);
      for (const x of othersOf(d.me)) {
        const g = parseSolve(await run(dir, `${ri + 1}-guess-${d.me.slug}-${x.slug}`, x, guessPrompt(x, d.me, d.svg), meeting));
        g.right = named(g.answer, d.word, m.accept[d.word]);
        if (g.right) { x.score++; d.me.score++; }
        r.guesses.push({ id: x.id, label: x.label, ...g });
        console.log(`  ⚑ ${d.me.label} drew "${d.word}": ${x.label} said "${g.answer}", ${g.right ? 'right' : 'wrong'}`);
      }
      rounds.push(r);
    }
  }
  for (const me of agents) me.after = await run(dir, `${m.words.length + 1}-after-${me.slug}`, me, afterPrompt(me, othersOf(me), rounds), me.home);

  const { redact, leaks } = redactor(m.redact);
  const r = t => redact(t ?? '');
  const st = {
    agents: agents.map(x => ({ id: x.id, label: x.label, model: x.model, score: x.score, after: r(x.after) })),
    rounds: rounds.map(x => ({ ...x, note: r(x.note), guesses: x.guesses.map(g => ({ ...g, working: r(g.working) })) })),
  };
  const text = markdown(st);
  const left = leaks(text + JSON.stringify(st));
  if (left.length) throw new Error(`Not written: the episode still contains ${left.length} redacted term(s). See ${dir}/steps.`);
  fs.writeFileSync(path.join(dir, 'episode.json'), JSON.stringify(st, null, 2));
  fs.writeFileSync(path.join(dir, 'episode.md'), text);
  console.log(`Score: ${st.agents.map(x => `${x.label} ${x.score}`).join(' · ')}\nEpisode: ${path.join(dir, 'episode.md')}`);
}

if (require.main === module) main().catch(e => { console.error(`sketch: ${e.message}`); process.exit(1); });

module.exports = { clean, broken, shapeCount, parseDrawing, named, drawPrompt, guessPrompt };
