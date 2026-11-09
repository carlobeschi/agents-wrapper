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
//   "learn": { "id": "...", "kind": "svg", "brief": "..." },
//   "repeats": 1 }
// A task may give "roles": two open jobs, e.g. ["You write the lines.",
// "You edit: cut, sharpen, reorder."]. Then there is a fourth condition,
// "together, roles", and the jobs swap between agents on every repeat.
// Every condition runs "repeats" times; each repeat is judged as its own set.
// Lessons only carry over from tasks of the same kind as the learning task.
// A solo run gets twice the moves and twice the minimum touches of one agent
// in a pair, so it can do as much work as the pair. Nothing is published.
//
// Study 3 additions:
// - "agents" can hold 2 to 4 players, and the same model more than once
//   ("claude#1", "claude#2"). Roles rotate by one place every repeat.
// - A task with "checker": true makes its last role a checker who may only
//   talk (room.js "readonly"); its condition is called "writer + checker".
// - Checks (room.js) are scored per condition: average passed, and how many
//   runs passed every check. "room": { "self_review": true } gives every
//   editing agent, alone or not, one review move before its "done" counts.
// - A task with "puzzle": { "size", "code", "clues" } (see puzzles.js) is a
//   code puzzle: the brief lists the clues, the answer is checked, and for a
//   wrong answer the app lists the clues it breaks and asks "diagnose" (an
//   agent, default the first judge) whether a clue was missed or misapplied.
// - "judge": false on a task skips the judges (answers are right or wrong).
// Run folder: ~/.agent-dispatch/studies/<run>/: study.json, summary.md,
// judge/ (pictures and prompts); each room run keeps its own folder.

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { HOME_DIR, loadConfig, stamp } = require('./config');
const { UNATTENDED } = require('./talk');
const { run } = require('./motion');
const room = require('./room');
const puzzles = require('./puzzles');

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

const diagnosePrompt = (p, answer, broke, work) => [
  `Someone tried to solve this code puzzle. ${puzzles.brief(p)}`,
  '', `Their answer: ${answer || '(none)'}. The right answer is ${p.code}. Their answer breaks these clues: ${broke.map(c => `"${c.say}"`).join('; ')}.`,
  '', 'Their working, as they left it:', '```', String(work).trim() || '(empty)', '```',
  '', 'Why did they go wrong? MISSED means the working never uses a broken clue (it was skipped or forgotten). INFERENCE means the working uses it but draws a wrong conclusion from it, or an arithmetic slip. OTHER means neither (no answer, a typo, ran out of time).',
  'Reply with exactly one line: "KIND: MISSED | one short reason" (or INFERENCE, or OTHER). Nothing else.',
  UNATTENDED(),
].join('\n');

const mean = xs => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 10) / 10 : null;
const avgOf = (judgings, label) => mean(judgings.flatMap(j => (j.pieces || []).filter(p => p.label === label && p.score != null).map(p => p.score)));

async function main(file) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const all = loadConfig().agents;
  const pick = id => room.resolveAgent(all, id);
  const agents = cfg.agents.map(pick), judges = (cfg.judges || cfg.agents.map(id => String(id).split('#')[0]).filter((x, i, a) => a.indexOf(x) === i)).map(pick);
  if (agents.length < 1 || agents.length > 4) throw new Error('a study has 1 to 4 agents');
  const specs = Object.fromEntries(agents.map((a, i) => [a.id, cfg.agents[i]]));
  const diagnoser = pick(cfg.diagnose || judges[0].id);
  const base = { silent: true, turns: true, moves: 8, min_moves: 3, lines_per_move: 4, max_minutes: 6, words: 25, ...(cfg.room || {}) };
  const dir = path.join(HOME_DIR, 'studies', `${stamp()}-${crypto.randomBytes(2).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 1));
  console.log(`Study folder: ${dir}`);
  const study = { title: cfg.title, agents: agents.map(a => ({ id: a.id, label: a.label, model: a.model || null })), judges: judges.map(j => j.id), tasks: [], learn: null };
  const save = () => fs.writeFileSync(path.join(dir, 'study.json'), JSON.stringify(study, null, 2));
  const minOf = t => t.min_moves ?? base.min_moves ?? 0;
  // A task as the room sees it: a puzzle becomes its brief and an answer check.
  const asRoom = t => {
    const { roles, checker, puzzle, judge, repeats: _r, ...rest } = t;
    return puzzle ? { kind: 'scratchpad', ...rest, brief: puzzles.brief(puzzle), checks: [...(t.checks || []), { say: 'The answer is right.', type: 'answer', pattern: `^\\D*${puzzle.code.split('').join('\\D*')}\\D*$` }] } : rest;
  };
  // A solo agent gets as many moves as the whole group put together.
  const solo = (t, a, extra = {}) => ({ ...base, ...asRoom(t), ...extra, agents: [specs[a.id]], title: `${t.id} · ${a.label} alone${extra.tag ? ` (${extra.tag})` : ''}`,
    moves: (t.moves ?? base.moves) * agents.length, min_moves: minOf(t) * agents.length, safe_word: undefined, lesson: false, readonly: [] });
  const roomRun = async (c, t) => {
    const { tag, ...rest } = c;
    const r = await room.main(rest);
    const res = r.out.results || [];
    const got = { dir: r.dir, guess: r.out.guess?.score || null, seconds: Math.round(r.out.seconds), lessons: r.out.lessons || {},
      checks: res.length ? { passed: res.filter(x => x.pass).length, of: res.length, failed: res.filter(x => !x.pass).map(x => x.say) } : null,
      moves: r.out.moves?.length ?? null };
    if (t?.puzzle) {
      const answer = ((r.out.final || []).map(l => l.text.match(/^\s*ANSWER\s*:\s*(.*)$/i)).filter(Boolean).pop() || [])[1] || null;
      const broke = puzzles.broken(t.puzzle.clues, answer, t.puzzle.size);
      got.puzzle = { answer, right: puzzles.digitsOf(answer, t.puzzle.size)?.join('') === t.puzzle.code, broke: broke.map(c => c.say) };
      if (!got.puzzle.right) {
        try {
          const said = await run(r.dir, 'diagnose', diagnoser, diagnosePrompt(t.puzzle, answer, broke, (r.out.final || []).map(l => l.text).join('\n')), path.join(r.dir, 'cwd'));
          const m = said.match(/KIND\s*:\s*[*_]*(MISSED|INFERENCE|OTHER)[*_]*\s*(?:\|\s*(.*))?/i);
          got.puzzle.why = m ? { kind: m[1].toLowerCase(), reason: (m[2] || '').trim() } : { kind: 'unclear', reason: said.split('\n')[0] };
        } catch (e) { got.puzzle.why = { kind: 'unclear', reason: e.message.split('\n')[0] }; }
      }
    }
    return got;
  };

  // 1. Alone, then together.
  const repeats = cfg.repeats || 1;
  const lessons = Object.fromEntries(agents.map(a => [a.id, []]));
  const together = (t, extra = {}) => {
    const r = asRoom(t), min = minOf(t);
    return { ...base, ...r, agents: agents.map(a => specs[a.id]), ...extra, lesson: true, min_moves: min,
      brief: `${r.brief} ${PAIR()}${min ? ` ${extra.readonly?.length ? 'Each of you who edits' : 'Each of you'} must change it at least ${min} times.` : ''}` };
  };
  for (const t of cfg.tasks) {
    const task = { id: t.id, kind: t.kind, brief: t.brief, repeats: [] };
    study.tasks.push(task);
    for (let r = 0; r < repeats; r++) {
      console.log(`\n# ${t.id}${repeats > 1 ? `, repeat ${r + 1} of ${repeats}` : ''}`);
      const runs = {};
      task.repeats.push({ runs });
      for (const a of agents) { console.log(`- ${a.label} alone`); runs[`${a.id} alone`] = await roomRun(solo(t, a), t); save(); }
      console.log('- together');
      runs.together = await roomRun(together(t, { title: `${t.id} · together` }), t);
      if (t.roles) {
        // Rotate the jobs on every repeat, so a job is not tied to one agent.
        const ids = agents.map(a => a.id), k = r % ids.length;
        const order = ids.slice(k).concat(ids.slice(0, k));
        const roles = Object.fromEntries(order.map((id, i) => [id, t.roles[Math.min(i, t.roles.length - 1)]]));
        const readonly = t.checker ? order.filter((id, i) => Math.min(i, t.roles.length - 1) === t.roles.length - 1) : [];
        const label = t.checker ? 'writer + checker' : 'together, roles';
        console.log(`- ${label} (${order.map((id, i) => `${id}: role ${Math.min(i, t.roles.length - 1) + 1}`).join(', ')})`);
        runs[label] = await roomRun(together(t, { title: `${t.id} · ${label}`, roles, readonly, agents: order.map(id => specs[id]) }), t);
        task.repeats[r].roles = roles;
      }
      for (const label of ['together', 'together, roles', 'writer + checker']) for (const [id, l] of Object.entries(runs[label]?.lessons || {})) lessons[id].push({ kind: t.kind, task: t.id, text: l });
      save();
      task.repeats[r].judgings = t.judge === false ? [] : await judgeSet(dir, `${t.id}-${r + 1}`, t.kind, t.brief, Object.entries(runs).map(([label, x]) => ({ label, dir: x.dir })), judges);
      save();
    }
    const labels = Object.keys(task.repeats[0].runs);
    const allJ = task.repeats.flatMap(x => x.judgings);
    task.average = Object.fromEntries(labels.map(l => [l, avgOf(allJ, l)]));
    task.best = Object.fromEntries(labels.map(l => [l, allJ.filter(j => j.best === l).length]));
    task.guesses = Object.fromEntries(labels.map(l => [l, task.repeats.map(x => x.runs[l]?.guess).filter(Boolean)]));
    task.checks = Object.fromEntries(labels.map(l => {
      const cs = task.repeats.map(x => x.runs[l]?.checks).filter(Boolean);
      return [l, cs.length ? { mean: mean(cs.map(c => c.passed)), of: cs[0].of, all: cs.filter(c => c.passed === c.of).length, runs: cs.length } : null];
    }));
    if (t.puzzle) task.puzzle = Object.fromEntries(labels.map(l => {
      const ps = task.repeats.map(x => x.runs[l]?.puzzle).filter(Boolean);
      const why = {};
      for (const p of ps) if (!p.right) why[p.why?.kind || 'unclear'] = (why[p.why?.kind || 'unclear'] || 0) + 1;
      return [l, { right: ps.filter(p => p.right).length, runs: ps.length, why }];
    }));
    save();
  }

  // 2. Did anyone learn something? Before, practice only, with lessons.
  if (cfg.learn) {
    const t = cfg.learn;
    console.log(`\n# learning: ${t.id}`);
    // Only lessons from the same kind of work: drawing tips for a drawing.
    const same = Object.fromEntries(Object.entries(lessons).map(([id, ls]) => [id, ls.filter(l => l.kind === t.kind).map(l => l.text)]));
    study.learn = { id: t.id, kind: t.kind, brief: t.brief, lessons: same, agents: {} };
    for (const a of agents) {
      const notes = same[a.id];
      const reps = [];
      for (let r = 0; r < repeats; r++) {
        const runs = {};
        console.log(`- ${a.label}${repeats > 1 ? `, repeat ${r + 1}` : ''}: before`); runs.before = await roomRun(solo(t, a, { tag: 'before' }), t);
        console.log(`- ${a.label}: practice only`); runs.practice = await roomRun(solo(t, a, { tag: 'practice' }), t);
        console.log(`- ${a.label}: with lessons (${notes.length})`);
        runs.lessons = await roomRun(solo(t, a, { tag: 'with lessons', secrets: notes.length
          ? { [a.id]: `Techniques you noted while working with ${agents.filter(x => x !== a).map(x => x.label).join(' and ')}, to use if they help:\n${notes.map(n => `- ${n}`).join('\n')}` } : {} }));
        const judgings = await judgeSet(dir, `${t.id}-${a.id}-${r + 1}`, t.kind, t.brief, Object.entries(runs).map(([label, x]) => ({ label, dir: x.dir })), judges);
        reps.push({ runs, judgings });
        save();
      }
      const allJ = reps.flatMap(x => x.judgings), labels = Object.keys(reps[0].runs);
      study.learn.agents[a.id] = { repeats: reps, average: Object.fromEntries(labels.map(l => [l, avgOf(allJ, l)])),
        best: Object.fromEntries(labels.map(l => [l, allJ.filter(j => j.best === l).length])) };
      save();
    }
  }

  fs.writeFileSync(path.join(dir, 'summary.md'), summaryMd(study));
  console.log(`\n${summaryMd(study)}`);
  console.log(`Summary: ${path.join(dir, 'summary.md')}`);
  return { dir, study };
}

function summaryMd(s) {
  const L = [`# ${s.title || 'Solo vs together'}`, '', `Judges (blind): ${s.judges.join(', ')}. Scores 1-10, averaged over judges and repeats. "best" counts how often a judge picked it as the best of its set.`, '', '## Alone or together', ''];
  for (const t of s.tasks) {
    L.push(`### ${t.id} (${t.repeats.length} repeat${t.repeats.length === 1 ? '' : 's'})`, '',
      ...Object.keys(t.repeats[0]?.runs || {}).map(l => {
        const c = t.checks?.[l], p = t.puzzle?.[l];
        return [`- ${l}:`, t.average?.[l] != null ? `${t.average[l]} · best ${t.best?.[l] ?? 0}` : null,
          p ? `right ${p.right}/${p.runs}${Object.keys(p.why).length ? ` (wrong: ${Object.entries(p.why).map(([k, n]) => `${n} ${k}`).join(', ')})` : ''}` : null,
          c && !p ? `checks ${c.mean}/${c.of} on average, all passed in ${c.all}/${c.runs}` : null,
          t.guesses?.[l]?.length ? `guesses ${t.guesses[l].join(', ')}` : null].filter(Boolean).join(' · ').replace(': · ', ': ');
      }));
    const errs = t.repeats.flatMap(x => (x.judgings || []).filter(j => j.error).map(j => `${j.judge}: ${j.error}`));
    if (errs.length) L.push(`- judge errors: ${errs.join('; ')}`);
    L.push('');
  }
  if (s.learn) {
    L.push('## Did they learn from each other?', '', `Task: ${s.learn.brief}`, '');
    for (const [id, x] of Object.entries(s.learn.agents)) {
      L.push(`### ${s.agents.find(a => a.id === id)?.label || id}`, '', `Lessons carried over: ${(s.learn.lessons[id] || []).map(l => `"${l}"`).join('; ') || '(none)'}`, '',
        ...Object.entries(x.average).map(([l, v]) => `- ${l}: ${v ?? 'n/a'} · best ${x.best?.[l] ?? 0}`), '');
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
