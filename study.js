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
// - Scaling curve: "scale": { "agent": "claude", "sizes": [1, 2, 3, 4] } runs
//   every task with 1, 2, 3 and 4 copies of one model instead of alone and
//   together. Every agent has the same moves and the same time box, so a
//   bigger group has more hands but no more time. A task with "bank": [puzzles]
//   is many code puzzles in one document; the score is how many are right.
// - Interventions (study 5): "variants": [{ "label", "room": {...}, "roles"?,
//   "checker"?, "only"?: [task ids] }] runs the same team under each variant
//   (A/B against the first one), plus "solo": ["claude"] runs alone. Besides
//   the blind judges, "process_judges" read each team run's transcript with
//   the names taken out and count: changes of mind caused by the other,
//   mistakes caught, mistakes passed on, and ideas built on. The app's own
//   counts (questions, clashes, lines removed from the other, share of the
//   final piece, proposals) come from room.js.
// - Tournament (study 8): a variant with "tournament": { "generate": [specs],
//   "review": spec, "rank": spec } does not talk at all: each generator drafts
//   alone with half its moves, the reviewer critiques each draft, each
//   generator revises its own draft with the other half, and the ranker picks
//   the better version, which the judges see. The summary says who won, how
//   alike the drafts were and how much a revision kept, and for every arm how
//   alike its final pieces are across repeats. "revise": false makes it a
//   best of N: each generator makes the whole piece alone with its share of the
//   moves, and the ranker picks one. "reviewer_as": text tells each reviser
//   who reviewed its draft ("Gemini, a model from another company"), and
//   "author_as" tells the reviewer who made the draft: labels that may be
//   false, to test whether "the other" works by being different or by being
//   called different (study 11).
// - Bench support: a variant may bring its own team ("agents": [specs]; the
//   moves are shared so the total stays the same) and "not_judged_by": [judge
//   ids] (a judge never scores a setup it played a part in); "repeat_offset"
//   shifts who starts when each repeat is its own study.
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
async function judgeSet(dir, name, kind, brief, entries, judges, retry = async () => false) {
  const out = [];
  for (const j of judges) {
    // A judge never scores a piece made by a setup it played a part in.
    const order = shuffle(entries.filter(e => !(e.skip || []).includes(j.id)), `${name}-${j.id}`);
    if (!order.length) continue;
    const pieces = order.map((e, i) => ({ ...e, letter: LETTERS[i] }));
    const jdir = path.join(dir, 'judge', `${name}-${j.id}`);
    fs.mkdirSync(jdir, { recursive: true });
    if (kind === 'svg') {
      let drawn = true;
      for (const p of pieces) drawn = drawn && await room.render(fs.readFileSync(path.join(p.dir, 'final.svg'), 'utf8'), path.join(jdir, `${p.letter}.png`));
      if (!drawn) { out.push({ judge: j.id, error: 'could not render the pictures' }); continue; }
    } else for (const p of pieces) p.text = fs.readFileSync(path.join(p.dir, 'final.txt'), 'utf8');
    try {
      let said;
      try { said = await run(dir, `judge-${name}-${j.id}`, j, judgePrompt(kind, brief, pieces), jdir); }
      catch (e) { if (!await retry()) throw e; said = await run(dir, `judge-${name}-${j.id}-again`, j, judgePrompt(kind, brief, pieces), jdir); }
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

// A team run's transcript with the agents' names taken out, for the process judges.
function transcript(tl) {
  const name = {}; tl.agents.forEach((a, i) => { name[a.id] = `Agent ${i + 1}`; });
  const hide = t => tl.agents.reduce((x, a) => x.split(a.label).join(name[a.id]), String(t || ''));
  const L = [`Brief: ${hide(tl.brief)}`, ''];
  for (const m of tl.moves) {
    L.push(`--- move ${m.n}, ${name[m.agent]} ---`);
    if (m.say) L.push(`said: ${hide(m.say)}`);
    if (m.planText && m.plan) L.push(`plan ${m.plan}: ${hide(m.planText)}`);
    if (m.landed.length) L.push(`edits that landed: ${m.landed.join(', ')}`);
    if (m.dropped.length) L.push(`edits refused: ${m.dropped.map(d => `${d.op} (${d.why})`).join('; ')}`);
    if (m.proposed?.length) L.push(`proposed: ${m.proposed.join(', ')}`);
    if (m.decisions?.length) L.push(`decided: ${m.decisions.join(', ')}`);
    if (m.note) L.push(`private note: ${hide(m.note)}`);
    L.push('document after:', ...(m.after || []).map((l, i) => `${String(i + 1).padStart(2)}| ${l.text}  [${name[l.by] || l.by}]`));
  }
  return L.join('\n');
}

const processPrompt = text => [
  'Below is the full record of AI agents making one piece together in a shared document: what each said, its private notes (the others never saw these), its edits, and the document after every move, with who wrote each line in brackets.',
  '', '```', text, '```', '',
  'Count, from the record only:',
  'CHANGED: times an agent changed its own plan or its own work because of something the other did or said (not just continuing its own plan).',
  'CAUGHT: mistakes (against the brief or its rules) that one agent made and the other noticed and fixed or pointed out.',
  'PASSED: mistakes one agent made that the other kept, built on, or left in the final piece.',
  'BUILT: times an agent built directly on the other\'s idea (extended it, rather than replacing it).',
  'Reply with exactly four lines, "CHANGED: <number> | one short example", then CAUGHT, PASSED, BUILT in the same form. Nothing else.',
  UNATTENDED(),
].join('\n');

function parseProcess(text) {
  const out = {};
  for (const k of ['CHANGED', 'CAUGHT', 'PASSED', 'BUILT']) {
    const m = String(text).match(new RegExp(`^\\s*[*_]*${k}[*_]*\\s*:\\s*(\\d+)\\s*(?:\\|\\s*(.*))?$`, 'im'));
    if (m) out[k.toLowerCase()] = { n: Number(m[1]), example: (m[2] || '').trim() };
  }
  return out;
}

const reviewPrompt = (kind, brief, checks, text, authorAs) => [
  ...(authorAs ? [`This draft was made by ${authorAs}.`] : []),
  'Review this draft. It was made for this brief:', '', brief, ...(checks.length ? ['', 'The app also checks at the end:', ...checks.map(c => `- ${c}`)] : []), '',
  kind === 'svg' ? 'The draft is the picture draft.png in your current folder. Look at it.' : `--- draft ---\n${String(text).trim()}`, '',
  'Review it in three passes: (1) BRIEF: what the brief or the checks ask for that is missing, wrong or hard to see; (2) READER: what someone meeting it for the first time would misread or stumble on; (3) CRAFT: what would make it better made.',
  'Then list at most 5 concrete changes, most important first. Do not rewrite it yourself.',
].join('\n');

// How alike two pieces are: shared five-letter pieces of text, 0-100.
function alike(a, b) {
  const sh = s => { const x = String(s).toLowerCase().replace(/\s+/g, ' '), set = new Set(); for (let i = 0; i + 5 <= x.length; i++) set.add(x.slice(i, i + 5)); return set; };
  const A = sh(a), B = sh(b); let n = 0; for (const x of A) if (B.has(x)) n++;
  const u = A.size + B.size - n; return u ? Math.round(n / u * 100) : 100;
}

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
    const { roles, checker, puzzle, judge, repeats: _r, bank, ...rest } = t;
    if (bank) return { kind: 'scratchpad', ...rest, brief: puzzles.bankBrief(bank) + (t.brief ? `\n${t.brief}` : ''), checks: [...(t.checks || []), ...puzzles.bankChecks(bank)] };
    return puzzle ? { kind: 'scratchpad', ...rest, brief: puzzles.brief(puzzle), checks: [...(t.checks || []), { say: 'The answer is right.', type: 'answer', pattern: `^\\D*${puzzle.code.split('').join('\\D*')}\\D*$` }] } : rest;
  };
  // A solo agent gets as many moves as the whole group put together.
  const solo = (t, a, extra = {}) => ({ ...base, ...asRoom(t), ...extra, agents: [specs[a.id] || a.id], title: `${t.id} · ${a.label} alone${extra.tag ? ` (${extra.tag})` : ''}`,
    moves: (t.moves ?? base.moves) * agents.length, min_moves: minOf(t) * agents.length, safe_word: undefined, lesson: false, readonly: [] });
  const roomRun = async (c, t) => {
    const { tag, ...rest } = c;
    let r = await room.main(rest);
    if (cfg.ping && (r.out.failed_calls || r.out.knocked_out?.length) && await waitForUsage()) {
      console.log('  (run again after waiting out the usage limit)');
      r = await room.main(rest);
    }
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

  const together = (t, extra = {}) => {
    const r = asRoom(t), min = minOf(t);
    return { ...base, ...r, agents: agents.map(a => specs[a.id]), ...extra, lesson: true, min_moves: min,
      brief: `${r.brief} ${PAIR()}${min ? ` ${extra.readonly?.length ? 'Each of you who edits' : 'Each of you'} must change it at least ${min} times.` : ''}` };
  };
  const repeats = cfg.repeats || 1;
  const processJudges = (cfg.process_judges || []).map(pick);

  // Out of usage ("You've hit your 5-hour limit · resets 3:50am"): ping every model;
  // if one is out and says it resets within STUDY_MAX_WAIT_MIN (150), wait and go on,
  // as organise.js does. A room run that lost calls is then run again; a judge, asked again.
  const everyone = [...new Map([...agents, ...judges, ...processJudges].map(a => [a.id, a])).values()];
  async function pingAll(tag) {
    const dead = [];
    for (const a of everyone) {
      try { await run(dir, `${tag}-${a.id}`, a, 'Reply with the single word OK.', dir); }
      catch (e) { dead.push(`${a.id}: ${e.message.split('\n').slice(0, 3).join(' ')}`); }
    }
    return dead;
  }
  let waits = 0;
  async function waitForUsage() {
    if (cfg.ping === false || waits >= 3) return false;
    const dead = await pingAll(`ping-${Date.now()}`);
    if (!dead.length) return false; // everyone answers: not a usage limit
    const until = require('./organise').resetTime(dead.join(' '));
    const maxMs = Number(process.env.STUDY_MAX_WAIT_MIN ?? 150) * 60000;
    if (!until || until - Date.now() > maxMs) { console.error(`Not answering, and no reset within ${maxMs / 60000} min:\n${dead.map(d => `- ${d}`).join('\n')}`); return false; }
    const ms = (until - Date.now() + Number(process.env.STUDY_RESET_MARGIN_S ?? 300) * 1000) * Number(process.env.STUDY_WAIT_SCALE || 1); // the scale is for tests
    waits++;
    console.error(`Out of usage: waiting ${Math.round(ms / 60000)} min, until about ${new Date(Date.now() + ms).toTimeString().slice(0, 5)}, then going on.`);
    await new Promise(res => setTimeout(res, Math.max(0, ms)));
    return !(await pingAll(`ping-${Date.now()}`)).length;
  }
  if (cfg.ping) { // opt-in: a model out of usage at the start stops the study at once, unless its reset is close
    const dead = await pingAll('ping');
    if (dead.length && !await waitForUsage()) { console.error(`Not starting: ${dead.length} agent(s) did not answer:\n${dead.map(d => `- ${d}`).join('\n')}`); process.exit(3); }
  }
  async function processLabels(runDir, name) {
    const tl = JSON.parse(fs.readFileSync(path.join(runDir, 'timeline.json'), 'utf8'));
    if (tl.agents.length < 2) return null;
    const text = transcript(tl), out = [];
    for (const j of processJudges) {
      const ask = tag => run(dir, `process-${name}-${j.id}${tag}`, j, processPrompt(text), path.join(runDir, 'cwd'));
      try {
        let said;
        try { said = await ask(''); } catch (e) { if (!(cfg.ping && await waitForUsage())) throw e; said = await ask('-again'); }
        out.push({ judge: j.id, ...parseProcess(said) });
      } catch (e) { out.push({ judge: j.id, error: e.message.split('\n')[0] }); }
    }
    return out;
  }

  // Study 8: a Co-Scientist-style tournament in place of a conversation. Each
  // generator drafts alone with half of its moves; a reviewer critiques every
  // draft (it never edits); each generator revises its own draft, as a new
  // version, with the other half; a ranker picks the better version, which is
  // the arm's piece for the judges. The generators never talk. Edit moves are
  // the same as in a conversation of the same size; the review and rank calls
  // come on top (one per draft, one per repeat).
  async function tournamentRun(t, v, r) {
    const T = v.tournament, gspecs = T.generate || cfg.agents, gens = gspecs.map(pick);
    const reviewer = pick(T.review || judges[0].id), ranker = pick(T.rank || judges[0].id);
    const rt = asRoom(t), total = t.moves ?? base.moves, half = Math.max(1, Math.floor(total / 2));
    const tag = `${t.id}-${r + 1}-${v.label.replace(/\W+/g, '-')}`;
    const alone = (i, extra) => ({ ...base, ...rt, ...(v.room || {}), ...extra, agents: [gspecs[i]], silent: true, safe_word: undefined, lesson: false,
      readonly: [], plan_first: false, versions: false });
    const piece = d => fs.readFileSync(path.join(d, t.kind === 'svg' ? 'final.svg' : 'final.txt'), 'utf8');
    const lines = d => (JSON.parse(fs.readFileSync(path.join(d, 'timeline.json'), 'utf8')).final || []).map(l => l.text);
    const drafts = [], revisions = [];
    if (T.revise === false) {
      // Best of N: each copy makes the whole piece alone with its share of the moves; the ranker picks one.
      const each = Math.max(1, Math.round(total * agents.length / gens.length));
      for (let i = 0; i < gens.length; i++) {
        console.log(`  piece ${i + 1}: ${gens[i].label}`);
        drafts.push(await roomRun(alone(i, { title: `${t.id} · ${v.label} · ${i + 1}`, moves: each, min_moves: Math.min(minOf(t), each) }), t));
        save();
      }
      revisions.push(...drafts);
    }
    for (let i = 0; i < (T.revise === false ? 0 : gens.length); i++) {
      console.log(`  draft ${i + 1}: ${gens[i].label}`);
      drafts.push(await roomRun(alone(i, { title: `${t.id} · ${v.label} · draft ${i + 1}`, moves: half, min_moves: Math.min(minOf(t), half) }), t));
      save();
    }
    for (let i = 0; i < (T.revise === false ? 0 : gens.length); i++) {
      const rdir = path.join(dir, 'review', `${tag}-${i + 1}`);
      fs.mkdirSync(rdir, { recursive: true });
      let critique = '';
      try {
        if (t.kind === 'svg' && !await room.render(piece(drafts[i].dir), path.join(rdir, 'draft.png'))) throw new Error('could not render the draft');
        critique = (await run(dir, `review-${tag}-${i + 1}`, reviewer, reviewPrompt(t.kind, rt.brief, (rt.checks || []).map(c => c.say), t.kind === 'svg' ? null : piece(drafts[i].dir), T.author_as), rdir)).trim();
      } catch (e) { drafts[i].reviewError = e.message.split('\n')[0]; }
      drafts[i].review = critique;
      console.log(`  revision ${i + 1}: ${gens[i].label}`);
      revisions.push(await roomRun(alone(i, { title: `${t.id} · ${v.label} · revision ${i + 1}`, start: lines(drafts[i].dir), moves: total - half, min_moves: 1,
        secrets: { [gens[i].id]: critique ? `The document is your own first draft. A reviewer${T.reviewer_as ? ` (${T.reviewer_as})` : ''} read it and said:\n${critique}\nRevise it: keep what works, act on what the review gets right, ignore what it gets wrong.`
          : 'The document is your own first draft. Read it again and make it better.' } }), t));
      save();
    }
    const ranked = await judgeSet(dir, `rank-${tag}`, t.kind, rt.brief, revisions.map((x, i) => ({ label: `v${i + 1}`, dir: x.dir })), [ranker]);
    const rk = ranked[0] || {};
    let w = rk.best ? Number(rk.best.slice(1)) - 1 : -1;
    if (w < 0 && rk.pieces) w = Number([...rk.pieces].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0].label.slice(1)) - 1;
    const rankFailed = w < 0; if (rankFailed) w = 0;
    return { ...revisions[w], starter: null, stats: null, process: null, tournament: {
      generators: gens.map(g => g.id), reviewer: T.revise === false ? null : reviewer.id, ranker: ranker.id, winner: gens[w].id, rankFailed, rank: rk,
      drafts: drafts.map((d, i) => ({ dir: d.dir, checks: d.checks, review: d.review || null, reviewError: d.reviewError || null, revision: revisions[i].dir, revisedChecks: revisions[i].checks,
        kept: alike(piece(d.dir), piece(revisions[i].dir)) })),
      draftsAlike: gens.length > 1 ? alike(piece(drafts[0].dir), piece(drafts[1].dir)) : null } };
  }

  // Interventions: the same team under each variant, A/B against the first.
  if (cfg.variants) {
    study.variants = cfg.variants.map(v => v.label);
    for (const t of cfg.tasks) {
      const task = { id: t.id, kind: t.kind, brief: t.brief || null, repeats: [] };
      study.tasks.push(task);
      for (let r = 0; r < repeats; r++) {
        const runs = {};
        task.repeats.push({ runs });
        console.log(`\n# ${t.id}, repeat ${r + 1} of ${repeats}`);
        for (const sp of cfg.solo || []) { const a = pick(sp); console.log(`- ${a.label} alone`); runs[`${a.id} alone`] = await roomRun(solo(t, a), t); save(); }
        // Rotate who moves first (and who holds which job) on every repeat.
        const ids = agents.map(a => a.id), k = (r + (cfg.repeat_offset || 0)) % ids.length, order = ids.slice(k).concat(ids.slice(0, k));
        for (const v of cfg.variants) {
          if (v.only && !v.only.includes(t.id)) continue;
          if (v.tournament) { console.log(`- ${v.label} (tournament)`); runs[v.label] = await tournamentRun(t, v, r); save(); continue; }
          let vorder = order, vspec = id => specs[id];
          const extra = { title: `${t.id} · ${v.label}`, ...(v.room || {}) };
          if (v.agents) {
            // A team of its own (a trio, a mixed pair): same total moves as the main team.
            const team = v.agents.map(pick), vs = Object.fromEntries(team.map((a, i) => [a.id, v.agents[i]]));
            const kk = (r + (cfg.repeat_offset || 0)) % team.length;
            vorder = team.map(a => a.id).slice(kk).concat(team.map(a => a.id).slice(0, kk)); vspec = id => vs[id];
            extra.moves = Math.max(1, Math.round((t.moves ?? base.moves) * agents.length / team.length));
          }
          extra.agents = vorder.map(vspec);
          if (v.roles) {
            extra.roles = Object.fromEntries(vorder.map((id, i) => [id, v.roles[Math.min(i, v.roles.length - 1)]]));
            if (v.checker) extra.readonly = vorder.filter((id, i) => Math.min(i, v.roles.length - 1) === v.roles.length - 1);
          }
          console.log(`- ${v.label} (${vorder.join(' first, ')})`);
          const got = await roomRun(together(t, extra), t);
          got.starter = vorder[0];
          got.stats = JSON.parse(fs.readFileSync(path.join(got.dir, 'timeline.json'), 'utf8')).stats || null;
          got.process = await processLabels(got.dir, `${t.id}-${r + 1}-${v.label.replace(/\W+/g, '-')}`);
          runs[v.label] = got;
          save();
        }
        task.repeats[r].judgings = t.judge === false ? [] : await judgeSet(dir, `${t.id}-${r + 1}`, t.kind, t.brief || asRoom(t).brief,
          Object.entries(runs).map(([label, x]) => ({ label, dir: x.dir, skip: cfg.variants.find(v => v.label === label)?.not_judged_by || [] })), judges, () => (cfg.ping ? waitForUsage() : false));
        save();
      }
      const labels = [...new Set(task.repeats.flatMap(x => Object.keys(x.runs)))];
      const allJ = task.repeats.flatMap(x => x.judgings);
      task.average = Object.fromEntries(labels.map(l => [l, avgOf(allJ, l)]));
      task.best = Object.fromEntries(labels.map(l => [l, allJ.filter(j => j.best === l).length]));
      task.guesses = Object.fromEntries(labels.map(l => [l, task.repeats.map(x => x.runs[l]?.guess).filter(Boolean)]));
      task.checks = Object.fromEntries(labels.map(l => {
        const cs = task.repeats.map(x => x.runs[l]?.checks).filter(Boolean);
        return [l, cs.length ? { mean: mean(cs.map(c => c.passed)), of: cs[0].of, all: cs.filter(c => c.passed === c.of).length, runs: cs.length } : null];
      }));
      // Results by who moved first (balanced: the starter rotates every repeat).
      task.byStarter = Object.fromEntries(labels.map(l => {
        const g = {};
        task.repeats.forEach(x => { const run = x.runs[l]; if (!run?.starter) return;
          const sc = (x.judgings || []).flatMap(j => (j.pieces || []).filter(p => p.label === l && p.score != null).map(p => p.score));
          (g[run.starter] ||= { runs: 0, scores: [], checks: [] }).runs++;
          g[run.starter].scores.push(...sc); if (run.checks) g[run.starter].checks.push(run.checks.passed); });
        return [l, Object.keys(g).length ? Object.fromEntries(Object.entries(g).map(([id, v]) => [id, { runs: v.runs, score: mean(v.scores), checks: mean(v.checks) }])) : null];
      }));
      // How alike the final pieces of one arm are across repeats (text overlap, 0-100).
      task.alike = Object.fromEntries(labels.map(l => {
        const ps = task.repeats.map(x => x.runs[l]?.dir).filter(Boolean).map(d => { try { return fs.readFileSync(path.join(d, t.kind === 'svg' ? 'final.svg' : 'final.txt'), 'utf8'); } catch { return null; } }).filter(Boolean);
        const pairs = ps.flatMap((a, i) => ps.slice(i + 1).map(b => alike(a, b)));
        return [l, pairs.length ? mean(pairs) : null];
      }));
      task.tournament = Object.fromEntries(labels.map(l => {
        const ts = task.repeats.map(x => x.runs[l]?.tournament).filter(Boolean);
        if (!ts.length) return [l, null];
        const wins = {}; for (const x of ts) wins[x.winner] = (wins[x.winner] || 0) + 1;
        const ds = ts.flatMap(x => x.drafts), dc = ds.filter(d => d.checks), rc = ds.filter(d => d.revisedChecks);
        return [l, { runs: ts.length, wins, rankFailed: ts.filter(x => x.rankFailed).length, draftsAlike: mean(ts.map(x => x.draftsAlike).filter(x => x != null)),
          kept: mean(ds.map(d => d.kept)), reviewErrors: ds.filter(d => d.reviewError).length,
          draftChecks: dc.length ? mean(dc.map(d => d.checks.passed)) : null, revisedChecks: rc.length ? mean(rc.map(d => d.revisedChecks.passed)) : null }];
      }));
      task.process = Object.fromEntries(labels.map(l => {
        const rs = task.repeats.map(x => x.runs[l]).filter(Boolean);
        const st = rs.map(x => x.stats).filter(Boolean);
        if (!st.length || rs[0].process == null) return [l, null];
        const lab = k => mean(rs.flatMap(x => (x.process || []).map(p => p[k]?.n).filter(n => n != null)));
        const props = st.filter(x => x.proposals);
        return [l, { questions: mean(st.map(x => x.questions)), clashes: mean(st.map(x => x.clashes)), removedOthers: mean(st.map(x => x.removedOthers)),
          topShare: mean(st.map(x => Math.max(...Object.values(x.share)))),
          accepted: props.length ? mean(props.map(x => x.proposals.accepted)) : null, rejected: props.length ? mean(props.map(x => x.proposals.rejected)) : null,
          planForced: st.some(x => x.planForced !== undefined) ? st.filter(x => x.planForced).length : null,
          lastMoverShare: mean(st.map(x => x.lastMoverShare).filter(x => x != null)),
          changed: lab('changed'), caught: lab('caught'), passed: lab('passed'), built: lab('built') }];
      }));
      save();
    }
    fs.writeFileSync(path.join(dir, 'summary.md'), summaryMd(study));
    console.log(`\n${summaryMd(study)}`);
    console.log(`Summary: ${path.join(dir, 'summary.md')}`);
    return { dir, study };
  }
  // 0. A scaling curve: 1, 2, 3, 4 copies of one model, same moves each, same time.
  if (cfg.scale) {
    study.scale = cfg.scale;
    for (const t of cfg.tasks) {
      const task = { id: t.id, kind: t.kind || 'scratchpad', brief: t.brief, repeats: [] };
      study.tasks.push(task);
      for (let r = 0; r < repeats; r++) {
        const runs = {};
        task.repeats.push({ runs, judgings: [] });
        for (const n of cfg.scale.sizes) {
          const label = `${n} ${cfg.scale.agent}${n > 1 ? ' copies' : ' alone'}`;
          console.log(`\n# ${t.id}, repeat ${r + 1} of ${repeats}: ${label}`);
          const ids = Array.from({ length: n }, (_, i) => `${cfg.scale.agent}#${i + 1}`);
          const c = { ...base, ...asRoom(t), agents: ids, title: `${t.id} · ${label}`, lesson: false };
          if (n === 1) c.safe_word = undefined;
          else c.brief = `${c.brief}\n${PAIR()}`;
          runs[label] = await roomRun(c, t);
          // Who wrote the answers that count: duplicated effort shows as answers rewritten by someone else.
          const tl = JSON.parse(fs.readFileSync(path.join(runs[label].dir, 'timeline.json'), 'utf8'));
          runs[label].answers = Object.fromEntries((tl.final || []).map(l => [l.text.match(/^\s*ANSWER\s*(\d+)\s*:/i)?.[1], l.by]).filter(([k]) => k));
          runs[label].rewritten = (tl.moves || []).reduce((sum, m) => sum + (m.landed || []).filter(x => /^replace/.test(x)).length, 0);
          save();
        }
      }
      const labels = Object.keys(task.repeats[0].runs);
      task.checks = Object.fromEntries(labels.map(l => {
        const cs = task.repeats.map(x => x.runs[l]?.checks).filter(Boolean);
        return [l, cs.length ? { mean: mean(cs.map(c => c.passed)), of: cs[0].of, all: cs.filter(c => c.passed === c.of).length, runs: cs.length,
          seconds: mean(task.repeats.map(x => x.runs[l].seconds)), moves: mean(task.repeats.map(x => x.runs[l].moves)) } : null];
      }));
      save();
    }
    fs.writeFileSync(path.join(dir, 'summary.md'), summaryMd(study));
    console.log(`\n${summaryMd(study)}`);
    console.log(`Summary: ${path.join(dir, 'summary.md')}`);
    return { dir, study };
  }

  // 1. Alone, then together.
  const lessons = Object.fromEntries(agents.map(a => [a.id, []]));
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
      task.repeats[r].judgings = t.judge === false ? [] : await judgeSet(dir, `${t.id}-${r + 1}`, t.kind, t.brief, Object.entries(runs).map(([label, x]) => ({ label, dir: x.dir })), judges, () => (cfg.ping ? waitForUsage() : false));
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
        const judgings = await judgeSet(dir, `${t.id}-${a.id}-${r + 1}`, t.kind, t.brief, Object.entries(runs).map(([label, x]) => ({ label, dir: x.dir })), judges, () => (cfg.ping ? waitForUsage() : false));
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
      ...[...new Set(t.repeats.flatMap(x => Object.keys(x.runs)))].map(l => {
        const c = t.checks?.[l], p = t.puzzle?.[l];
        return [`- ${l}:`, t.average?.[l] != null ? `${t.average[l]} · best ${t.best?.[l] ?? 0}` : null,
          p ? `right ${p.right}/${p.runs}${Object.keys(p.why).length ? ` (wrong: ${Object.entries(p.why).map(([k, n]) => `${n} ${k}`).join(', ')})` : ''}` : null,
          c && !p ? `${s.scale ? 'right' : 'checks'} ${c.mean}/${c.of} on average, all ${s.scale ? 'right' : 'passed'} in ${c.all}/${c.runs}${c.seconds != null ? ` · ${c.seconds}s · ${c.moves} moves` : ''}` : null,
          t.guesses?.[l]?.length ? `guesses ${t.guesses[l].join(', ')}` : null].filter(Boolean).join(' · ').replace(': · ', ': ');
      }));
    const starters = Object.entries(t.byStarter || {}).filter(([, v]) => v);
    if (starters.length) L.push('', 'By who moved first:', '',
      ...starters.map(([l, v]) => `- ${l}: ${Object.entries(v).map(([id, x]) => `${id} first (${x.runs} runs) ${x.score ?? 'n/a'}${x.checks != null ? `, checks ${x.checks}` : ''}`).join(' · ')}`));
    const procs = Object.entries(t.process || {}).filter(([, p]) => p);
    if (procs.length) L.push('', 'How they worked (per run, averaged; changed/caught/passed/built from the process judges, the rest counted by the app):', '',
      ...procs.map(([l, p]) => `- ${l}: changed ${p.changed ?? 'n/a'} · caught ${p.caught ?? 'n/a'} · passed ${p.passed ?? 'n/a'} · built ${p.built ?? 'n/a'} · questions ${p.questions} · clashes ${p.clashes} · lines removed from the other ${p.removedOthers} · top share ${p.topShare}%${p.lastMoverShare != null ? ` · last mover's share ${p.lastMoverShare}%` : ''}${p.accepted != null ? ` · proposals accepted ${p.accepted}, rejected ${p.rejected}` : ''}${p.planForced != null ? ` · plan forced in ${p.planForced}` : ''}`));
    const tours = Object.entries(t.tournament || {}).filter(([, v]) => v);
    if (tours.length) L.push('', 'Tournaments (drafts made alone, reviewed, revised, the better version picked by the ranker):', '',
      ...tours.map(([l, v]) => `- ${l}: winner ${Object.entries(v.wins).map(([id, n]) => `${id} ${n}`).join(', ')} of ${v.runs} · the two drafts alike ${v.draftsAlike ?? 'n/a'}% · a revision kept ${v.kept}% of its draft${v.draftChecks != null ? ` · checks ${v.draftChecks} in drafts, ${v.revisedChecks} after revision` : ''}${v.rankFailed ? ` · rank failed ${v.rankFailed}` : ''}${v.reviewErrors ? ` · review errors ${v.reviewErrors}` : ''}`));
    const al = Object.entries(t.alike || {}).filter(([, v]) => v != null);
    if (al.length) L.push('', 'How alike the final pieces of each arm are across repeats (text overlap; lower = more varied):', '', al.map(([l, v]) => `${l} ${v}%`).join(' · '));
    const errs = t.repeats.flatMap(x => (x.judgings || []).filter(j => j.error).map(j => `${j.judge}: ${j.error}`));
    if (errs.length) L.push(`- judge errors: ${errs.join('; ')}`);
    L.push('');
  }
  // Position check: the average score by the letter a piece was shown under.
  const all = [...s.tasks.flatMap(t => t.repeats.flatMap(x => x.judgings || [])), ...Object.values(s.learn?.agents || {}).flatMap(a => a.repeats.flatMap(x => x.judgings || []))];
  const byLetter = {};
  for (const j of all) for (const p of j.pieces || []) if (p.score != null) (byLetter[p.letter] ||= []).push(p.score);
  if (Object.keys(byLetter).length > 1) L.push('## Position check', '', 'Average score by the letter a piece was shown under (pieces are shuffled for every judge, so these should be close):', '',
    Object.keys(byLetter).sort().map(k => `${k}: ${mean(byLetter[k])} (n=${byLetter[k].length})`).join(' · '), '');
  if (s.learn) {
    L.push('## Did they learn from each other?', '', `Task: ${s.learn.brief}`, '');
    for (const [id, x] of Object.entries(s.learn.agents)) {
      L.push(`### ${s.agents.find(a => a.id === id)?.label || id}`, '', `Lessons carried over: ${(s.learn.lessons[id] || []).map(l => `"${l}"`).join('; ') || '(none)'}`, '',
        ...Object.entries(x.average).map(([l, v]) => `- ${l}: ${v ?? 'n/a'} · best ${x.best?.[l] ?? 0}`), '');
    }
  }
  return L.join('\n');
}

module.exports = { shuffle, parseScores, judgePrompt, summaryMd, transcript, parseProcess, alike, main };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node study.js <study.json>'); process.exit(2); }
  main(file).catch(e => { console.error(e.message); process.exit(1); });
}
