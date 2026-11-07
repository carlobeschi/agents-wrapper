#!/usr/bin/env node
// Solo vs together (pilot): `node study.js <study.json>`.
//
// Two questions, asked with the Same Page room (room.js):
//  1. Is the work better when agents make it together than when each makes it
//     alone? For every task, each agent makes it alone, then they make it
//     together. Judges score the pieces blind (labelled A, B, C in a shuffled
//     order, a different shuffle for each judge).
//  2. Do they learn something from each other? After making a piece together,
//     each agent names one technique it saw the other use (room.js "lesson").
//     On a fresh task, each agent works alone three times: before, again with
//     nothing new (practice only), and again with the lessons it noted. The
//     judges score those blind too. Learning shows as "with lessons" beating
//     "practice only".
//
// Config:
// { "title": "...", "agents": ["claude", "codex"], "judges": ["claude", "codex"],
//   "room": { shared room.js settings for every run: silent, turns, moves,
//             min_moves, lines_per_move, max_minutes, words, safe_word },
//   "tasks": [ { "id": "fox", "kind": "svg", "brief": "...", "start": [...], "guess": {...} } ],
//   "learn": { "id": "...", "kind": "svg", "brief": "..." } }
// A solo run gets twice the moves and twice the minimum touches of one agent
// in a pair, so it can do as much work as the pair. Nothing is published.
// Run folder: ~/.agent-dispatch/studies/<run>/: study.json, summary.md,
// judge/ (pictures and prompts); each room run keeps its own folder.

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { HOME_DIR, loadConfig, stamp } = require('./config');
const { UNATTENDED } = require('./talk');
const { run } = require('./motion');
const room = require('./room');

const PAIR = () => `You share one goal: make it as good as it can be, together.`;
const LETTERS = 'ABCDEFGHIJ';

function shuffle(xs, seed) {
  const a = xs.slice();
  let h = crypto.createHash('sha256').update(seed).digest();
  for (let i = a.length - 1; i > 0; i--) {
    const j = h[i % h.length] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
    if (i % 16 === 0) h = crypto.createHash('sha256').update(h).digest();
  }
  return a;
}

const judgePrompt = (kind, brief, pieces) => [
  `Here are ${pieces.length} ${kind === 'svg' ? 'pictures' : 'pieces'}, each made for the same brief: ${brief}`,
  '', kind === 'svg'
    ? `The pictures are the files ${pieces.map(p => `${p.letter}.png`).join(', ')} in your current folder. Look at every one.`
    : pieces.map(p => [`--- ${p.letter} ---`, p.text.trim()].join('\n')).join('\n\n'),
  '', 'Score each from 1 to 10 for how good it is as an answer to the brief: craft, clarity, and how well it would land with someone meeting it fresh. Be strict and use the whole scale; ties are allowed.',
  `Reply with exactly one line per piece, in the form "A: 7 | one short reason", then one line "BEST: <letter>". Nothing else.`,
  UNATTENDED(),
].join('\n');

function parseScores(text, letters) {
  const scores = {}, reasons = {};
  for (const l of String(text).split('\n')) {
    const m = l.match(/^\s*[*_]*([A-J])[*_]*\s*[:.)-]\s*(\d+(?:\.\d+)?)\s*(?:\/\s*10)?\s*(?:\|\s*(.*))?$/);
    if (m && letters.includes(m[1])) { scores[m[1]] = Number(m[2]); reasons[m[1]] = (m[3] || '').trim(); }
  }
  const best = (String(text).match(/BEST\s*:\s*[*_]*([A-J])/i) || [])[1] || null;
  return { scores, reasons, best };
}

// Show one set of finished pieces to every judge, blind.
async function judgeSet(dir, name, kind, brief, entries, judges) {
  const out = [];
  for (const j of judges) {
    const order = shuffle(entries, `${name}-${j.id}`);
    const pieces = order.map((e, i) => ({ ...e, letter: LETTERS[i] }));
    const jdir = path.join(dir, 'judge', `${name}-${j.id}`);
    fs.mkdirSync(jdir, { recursive: true });
    if (kind === 'svg') {
      let drawn = true;
      for (const p of pieces) drawn = drawn && await room.render(fs.readFileSync(path.join(p.dir, 'final.svg'), 'utf8'), path.join(jdir, `${p.letter}.png`));
      if (!drawn) { out.push({ judge: j.id, error: 'could not render the pictures' }); continue; }
    } else for (const p of pieces) p.text = fs.readFileSync(path.join(p.dir, 'final.txt'), 'utf8');
    try {
      const said = await run(dir, `judge-${name}-${j.id}`, j, judgePrompt(kind, brief, pieces), jdir);
      const r = parseScores(said, pieces.map(p => p.letter));
      out.push({ judge: j.id, pieces: pieces.map(p => ({ letter: p.letter, label: p.label, score: r.scores[p.letter] ?? null, reason: r.reasons[p.letter] || '' })),
        best: pieces.find(p => p.letter === r.best)?.label || null });
    } catch (e) { out.push({ judge: j.id, error: e.message.split('\n')[0] }); }
  }
  return out;
}

const mean = xs => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 10) / 10 : null;
const avgOf = (judgings, label) => mean(judgings.flatMap(j => (j.pieces || []).filter(p => p.label === label && p.score != null).map(p => p.score)));

async function main(file) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const all = loadConfig().agents;
  const pick = id => { const a = all.find(x => x.id === id && x.headless); if (!a) throw new Error(`no headless agent "${id}" in agents.json`); return a; };
  const agents = cfg.agents.map(pick), judges = (cfg.judges || cfg.agents).map(pick);
  const base = { silent: true, turns: true, moves: 8, min_moves: 3, lines_per_move: 4, max_minutes: 6, words: 25, ...(cfg.room || {}) };
  const dir = path.join(HOME_DIR, 'studies', `${stamp()}-${crypto.randomBytes(2).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 1));
  console.log(`Study folder: ${dir}`);
  const study = { title: cfg.title, agents: agents.map(a => ({ id: a.id, label: a.label, model: a.model || null })), judges: judges.map(j => j.id), tasks: [], learn: null };
  const save = () => fs.writeFileSync(path.join(dir, 'study.json'), JSON.stringify(study, null, 2));
  const solo = (t, a, extra = {}) => ({ ...base, ...t, ...extra, agents: [a.id], title: `${t.id} · ${a.label} alone${extra.tag ? ` (${extra.tag})` : ''}`,
    moves: base.moves * 2, min_moves: (base.min_moves || 0) * 2, safe_word: undefined, lesson: false });
  const roomRun = async c => { const { tag, ...rest } = c; const r = await room.main(rest); return { dir: r.dir, guess: r.out.guess?.score || null, seconds: Math.round(r.out.seconds), lessons: r.out.lessons || {} }; };

  // 1. Alone, then together.
  const lessons = Object.fromEntries(agents.map(a => [a.id, []]));
  for (const t of cfg.tasks) {
    console.log(`\n# ${t.id}`);
    const task = { id: t.id, kind: t.kind, brief: t.brief, runs: {} };
    study.tasks.push(task);
    for (const a of agents) { console.log(`- ${a.label} alone`); task.runs[`${a.id} alone`] = await roomRun(solo(t, a)); save(); }
    console.log('- together');
    const pair = await roomRun({ ...base, ...t, agents: agents.map(a => a.id), title: `${t.id} · together`, lesson: true,
      brief: `${t.brief} ${PAIR()} Each of you must change it at least ${base.min_moves} times.` });
    task.runs.together = pair;
    for (const [id, l] of Object.entries(pair.lessons)) lessons[id].push(l);
    save();
    task.judgings = await judgeSet(dir, t.id, t.kind, t.brief, Object.entries(task.runs).map(([label, r]) => ({ label, dir: r.dir })), judges);
    task.average = Object.fromEntries(Object.keys(task.runs).map(l => [l, avgOf(task.judgings, l)]));
    save();
  }

  // 2. Did anyone learn something? Before, practice only, with lessons.
  if (cfg.learn) {
    const t = cfg.learn;
    console.log(`\n# learning: ${t.id}`);
    study.learn = { id: t.id, kind: t.kind, brief: t.brief, lessons, agents: {} };
    for (const a of agents) {
      const runs = {};
      console.log(`- ${a.label}: before`); runs.before = await roomRun(solo(t, a, { tag: 'before' }));
      console.log(`- ${a.label}: practice only`); runs.practice = await roomRun(solo(t, a, { tag: 'practice' }));
      const notes = lessons[a.id];
      console.log(`- ${a.label}: with lessons (${notes.length})`);
      runs.lessons = await roomRun(solo(t, a, { tag: 'with lessons', secrets: notes.length
        ? { [a.id]: `Techniques you noted while working with ${agents.filter(x => x !== a).map(x => x.label).join(' and ')}, to use if they help:\n${notes.map(n => `- ${n}`).join('\n')}` } : {} }));
      const judgings = await judgeSet(dir, `${t.id}-${a.id}`, t.kind, t.brief, Object.entries(runs).map(([label, r]) => ({ label, dir: r.dir })), judges);
      study.learn.agents[a.id] = { runs, judgings, average: Object.fromEntries(Object.keys(runs).map(l => [l, avgOf(judgings, l)])) };
      save();
    }
  }

  fs.writeFileSync(path.join(dir, 'summary.md'), summaryMd(study));
  console.log(`\n${summaryMd(study)}`);
  console.log(`Summary: ${path.join(dir, 'summary.md')}`);
  return { dir, study };
}

function summaryMd(s) {
  const L = [`# ${s.title || 'Solo vs together'}`, '', `Judges (blind): ${s.judges.join(', ')}. Scores 1-10, averaged over judges.`, '', '## Alone or together', ''];
  for (const t of s.tasks) {
    L.push(`### ${t.id}`, '', ...Object.entries(t.average || {}).map(([l, v]) => `- ${l}: ${v ?? 'n/a'}${t.runs[l]?.guess ? ` (guess ${t.runs[l].guess})` : ''}`));
    const bests = (t.judgings || []).map(j => j.error ? `${j.judge}: ${j.error}` : `${j.judge} picked ${j.best}`);
    L.push(`- best: ${bests.join('; ')}`, '');
  }
  if (s.learn) {
    L.push('## Did they learn from each other?', '', `Task: ${s.learn.brief}`, '');
    for (const [id, x] of Object.entries(s.learn.agents)) {
      L.push(`### ${s.agents.find(a => a.id === id)?.label || id}`, '', `Lessons noted: ${(s.learn.lessons[id] || []).map(l => `"${l}"`).join('; ') || '(none)'}`, '',
        ...Object.entries(x.average).map(([l, v]) => `- ${l}: ${v ?? 'n/a'}`), `- best: ${x.judgings.map(j => j.error ? `${j.judge}: ${j.error}` : `${j.judge} picked ${j.best}`).join('; ')}`, '');
    }
  }
  return L.join('\n');
}

module.exports = { shuffle, parseScores, judgePrompt, summaryMd, main };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node study.js <study.json>'); process.exit(2); }
  main(file).catch(e => { console.error(e.message); process.exit(1); });
}
