#!/usr/bin/env node
// The agents choose how to work together: `node organise.js <organise.json> [--tasks a,b] [--out=<folder>]`.
//
// One ladder, the same task and the same budget on every rung:
//   solo - one worker alone, the whole budget.
//   L0   - an organisation we designed (a spec in the config).
//   L1   - a proposer (Claude, Gemini, Codex, an open model) gets only the
//          goal and the constraints and writes an organisation; the app runs it.
//   L3   - the proposer as researcher: it writes N different organisations,
//          each with a prediction; the app runs them all; it reads the results
//          (with solo and L0 beside them), writes what it found, and proposes a
//          revised organisation, which runs too (round 2).
// (L2, reorganising halfway, is not in this pilot.)
//   kata - after Rother's "Kata in the Classroom" (the Improvement Kata): the
//          same proposer improves an organisation over several rounds, each on
//          a NEW instance of the task (so nobody can carry an answer over).
//          Round 1 is our L0 design (the starting point, shared by every
//          chain of a repeat). Arms: "fixed" (L0 again every round: how much
//          the instances alone move the score), "free" (change anything),
//          "kata" (target, then each round: what did the last round teach
//          you, the obstacle now, change ONE setting, predict), "coach" (as
//          kata, but a coach of another vendor reads the draft and asks at most
//          3 questions; it never proposes settings). Measured by the app:
//          score by round, prediction error by round, how many settings each
//          round changed (one at a time or several), and whether a change that
//          made the score drop was kept or undone. Config "kata": { "rounds": 5,
//          "arms": [...], "coach": "other" (the next proposer) or an agent id,
//          "drop": 10 }.
//
// Safety and fairness: agents never run anything. A proposer only writes an
// organisation as JSON (the spec below); the app checks it against the budget
// and runs it with room.js. The workers are always copies of one model (the
// config's "worker"), so the proposers differ only in what they choose.
//
// Spec: { "name", "why", "prediction": 0-100, "steps": [...], "final": step id }
//   { "id", "do": "work", "agents": 1-N, "from": null | step id, "talk": bool,
//     "turns": bool, "versions": bool, "plan_first": bool, "words": 1-60,
//     "moves": moves per agent, "note": extra instruction, "notes_from": review id }
//   { "id", "do": "review", "from": step id }        a critique, no edits
//   { "id", "do": "pick", "from": [step ids] }       the better of several
//   { "id", "do": "merge", "from": [step ids], "moves" }  one agent combines them
// Several work steps "from" the same step are forks from the same state.
// Budget: work moves (agents x moves) + merge moves <= budget.moves; every
// review and pick is one call more; budget.minutes is the wall clock for the
// whole organisation (the time box that makes a big task too big for one).
//
// Scores are the app's own checks (share passed, 0-100). For a poem, judges
// also score quality 1-10 (a judge never scores an organisation it proposed).
// Out: ~/.agent-dispatch/organise/<stamp>/: runs.json, specs, reports, summary.md.
// Work already done is kept: run again with --out=<folder> to finish.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HOME_DIR, loadConfig, stamp } = require('./config');
const { UNATTENDED } = require('./talk');
const puzzles = require('./puzzles');

const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const r1 = x => x == null ? null : Math.round(x * 10) / 10;
const words = s => (String(s).match(/\S+/g) || []).length;

// ---- Tasks ----

// A seeded random number generator, so every rung of one repeat gets the same bank.
function seeded(seed) {
  let h = crypto.createHash('sha256').update(String(seed)).digest(), i = 0;
  return () => { if (i + 4 > h.length) { h = crypto.createHash('sha256').update(h).digest(); i = 0; } const x = h.readUInt32BE(i) / 2 ** 32; i += 4; return x; };
}

function taskFor(t, repeat) {
  if (t.bank) {
    const rnd = seeded(`${t.id}-${repeat}`);
    const bank = Array.from({ length: t.bank.count }, () => puzzles.generate(t.bank.size || 6, rnd));
    return { id: t.id, kind: 'scratchpad', judge: false, brief: puzzles.bankBrief(bank), checks: puzzles.bankChecks(bank), short: t.short || `${t.bank.count} code puzzles` };
  }
  return { ...t, judge: t.judge !== false, short: t.short || t.brief };
}

// ---- The spec ----

function parseSpecs(text) {
  const blocks = [...String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(m => m[1]);
  if (!blocks.length) { const a = String(text).indexOf('{'), b = String(text).lastIndexOf('}'); if (a >= 0 && b > a) blocks.push(String(text).slice(a, b + 1)); }
  const out = [];
  for (const b of blocks) {
    try { const j = JSON.parse(b); out.push(...(Array.isArray(j) ? j : Array.isArray(j.organisations) ? j.organisations : [j])); } catch {}
  }
  return out.filter(x => x && typeof x === 'object' && Array.isArray(x.steps));
}

// Checks a spec against the budget. Returns { ok, errors, cost }.
function validate(spec, budget) {
  const errors = [];
  const steps = Array.isArray(spec?.steps) ? spec.steps : [];
  if (!steps.length) errors.push('"steps" is missing or empty.');
  if (steps.length > (budget.max_steps || 8)) errors.push(`at most ${budget.max_steps || 8} steps.`);
  const seen = new Map();
  let moves = 0, calls = 0;
  for (const [k, s] of steps.entries()) {
    const at = `step ${k + 1}${s?.id ? ` ("${s.id}")` : ''}`;
    if (!s || typeof s !== 'object') { errors.push(`${at} is not an object.`); continue; }
    if (!/^[\w-]{1,20}$/.test(String(s.id || ''))) errors.push(`${at}: "id" must be a short name (letters, digits, - or _).`);
    else if (seen.has(s.id)) errors.push(`${at}: the id "${s.id}" is used twice.`);
    const earlier = id => seen.has(id);
    const froms = s.do === 'pick' || s.do === 'merge' ? s.from : [s.from];
    if (s.do === 'pick' || s.do === 'merge') {
      if (!Array.isArray(s.from) || s.from.length < 2) errors.push(`${at}: "from" must list at least 2 earlier steps.`);
    }
    for (const f of (Array.isArray(froms) ? froms : [])) {
      if (f == null && s.do === 'work') continue;
      if (!earlier(f)) errors.push(`${at}: "from" names "${f}", which is not an earlier step.`);
      else if (seen.get(f) === 'review') errors.push(`${at}: "from" names a review; a review has no piece (use "notes_from").`);
    }
    if (s.do === 'work') {
      const n = Number(s.agents), m = Number(s.moves);
      if (!Number.isInteger(n) || n < 1 || n > budget.max_agents) errors.push(`${at}: "agents" must be 1 to ${budget.max_agents}.`);
      if (!Number.isInteger(m) || m < 1) errors.push(`${at}: "moves" must be a whole number of at least 1.`);
      if (s.words != null && (!Number.isInteger(Number(s.words)) || s.words < 1 || s.words > 60)) errors.push(`${at}: "words" must be 1 to 60.`);
      if (s.note != null && words(s.note) > 60) errors.push(`${at}: "note" is over 60 words.`);
      if (s.notes_from != null && seen.get(s.notes_from) !== 'review') errors.push(`${at}: "notes_from" must name an earlier review step.`);
      if (Number.isInteger(n) && Number.isInteger(m)) { moves += n * m; calls += n * m; }
    } else if (s.do === 'merge') {
      const m = Number(s.moves);
      if (!Number.isInteger(m) || m < 1) errors.push(`${at}: "moves" must be a whole number of at least 1.`);
      else { moves += m; calls += m; }
    } else if (s.do === 'review') {
      if (Array.isArray(s.from)) errors.push(`${at}: a review reads one step.`);
      calls += 1;
    } else if (s.do === 'pick') calls += 1;
    else errors.push(`${at}: "do" must be work, review, pick or merge.`);
    if (s.id) seen.set(s.id, s.do);
  }
  const final = spec?.final ?? steps[steps.length - 1]?.id;
  if (steps.length && !seen.has(final)) errors.push(`"final" names "${final}", which is not a step.`);
  else if (seen.get(final) === 'review') errors.push('"final" must be a step that makes a piece, not a review.');
  if (moves > budget.moves) errors.push(`it uses ${moves} moves; the budget is ${budget.moves}.`);
  if (calls > budget.calls) errors.push(`it uses ${calls} calls (moves plus one per review and pick); the budget is ${budget.calls}.`);
  return { ok: !errors.length, errors, cost: { moves, calls } };
}

// One line a person can read: "2 copies talk in turns, 4 moves each -> review -> ...".
function describe(spec) {
  return (spec.steps || []).map(s => s.do === 'work'
    ? `${s.id}: ${s.agents === 1 ? '1 agent' : `${s.agents} agents`}${s.agents > 1 ? `${s.talk ? ' talking' : ' silent'}${s.turns === false ? ' at the same time' : ' in turns'}` : ''}${s.versions ? ', versions' : ''}${s.plan_first ? ', plan first' : ''}${s.words && s.talk ? `, ${s.words}-word messages` : ''}, ${s.moves} moves each${s.from ? `, from ${s.from}` : ''}${s.notes_from ? `, reading ${s.notes_from}` : ''}${s.note ? ` ("${s.note}")` : ''}`
    : s.do === 'review' ? `${s.id}: review of ${s.from}`
    : s.do === 'pick' ? `${s.id}: pick the best of ${s.from.join(', ')}`
    : `${s.id}: merge ${s.from.join(', ')} in ${s.moves} moves`).join(' → ');
}

const GRAMMAR = budget => [
  'An organisation is JSON: { "name": "...", "why": "one sentence", "prediction": 0-100, "steps": [ ... ], "final": "<id of the step whose piece is the answer>" }.',
  'Steps run in order. Kinds of step:',
  `- {"id": "a", "do": "work", "agents": 1-${budget.max_agents}, "moves": moves per agent, "from": null or an earlier step id, "talk": true/false, "turns": true/false, "versions": true/false, "plan_first": true/false, "words": 1-60, "note": "optional extra instruction, at most 60 words", "notes_from": "optional id of a review step"}`,
  '  Agents edit one shared document. "from": null starts from the empty task; "from": "a" starts from step a\'s finished piece; two work steps from the same step are two independent copies that diverge from the same state.',
  '  "talk": they may send each other one line per move ("words" caps its length); false = they never talk. "turns": false = they all edit at the same time, and clashing edits are dropped. "versions": changing another agent\'s lines becomes a proposal it accepts or rejects. "plan_first": no edit lands until they agree a plan. "note" is shown to every agent in the step. "notes_from" shows them a review.',
  '- {"id": "r", "do": "review", "from": "a"}: one agent reads step a\'s piece and writes a critique; it cannot edit.',
  '- {"id": "p", "do": "pick", "from": ["a", "b"]}: one agent picks the best of several pieces.',
  '- {"id": "m", "do": "merge", "from": ["a", "b"], "moves": n}: one agent starts from the first piece, sees the others, and combines them in n moves.',
  `Budget: work moves (agents × moves, summed over steps) plus merge moves must be at most ${budget.moves}; every review and pick costs one call more, and moves plus those calls must be at most ${budget.calls}. At most ${budget.max_steps || 8} steps. Everything must finish within ${budget.minutes} minutes of wall clock in total; steps run one after another, and agents in one step work in parallel only when "turns" is false.`,
].join('\n');

function goalLines(c, task, budget) {
  return [
    `The task: ${task.short}`,
    '', 'The full brief the workers will get:', task.brief,
    ...(task.checks?.length && !task.brief.includes('ANSWER') ? ['', 'The app checks at the end:', ...task.checks.map(x => `- ${x.say}`)] : []),
    '', `The workers are copies of one AI model (${c.worker_desc || 'the same model for everyone'}). Each move, an agent sees the document and may change up to ${c.room?.lines_per_move ?? 4} lines.`,
    `The score is ${task.judge ? 'half the share of checks passed, half the quality judged blind by others (0-100)' : 'the share of checks passed (0-100)'}.`,
    '', GRAMMAR(budget),
  ];
}

function l1Prompt(c, task, budget) {
  return [
    'You are designing how a group of AI agents will work together on a task. You will not do the task yourself.',
    ...goalLines(c, task, budget),
    '', 'Choose the organisation you expect to score highest. Any organisation the grammar allows is fine: it does not need to look like a human team.',
    'Reply with the JSON in one ```json block, and nothing else.',
    UNATTENDED(),
  ].join('\n');
}

function l3Prompt(c, task, budget) {
  return [
    'You are a researcher studying how AI agents can work together. You will design experiments; the app will run them and show you the results.',
    ...goalLines(c, task, budget),
    '', `Propose ${c.l3?.n || 3} organisations that are really different from each other, chosen to find out what makes a group work well on this task. They do not need to look like human teams.`,
    'For each, "why" is your hypothesis (what it tests) and "prediction" the score you expect.',
    'Reply with a JSON array of the organisations in one ```json block, and nothing else.',
    UNATTENDED(),
  ].join('\n');
}

function reportPrompt(c, task, budget, rows) {
  return [
    'You are a researcher studying how AI agents can work together. Earlier you proposed organisations for this task; the app ran them.',
    ...goalLines(c, task, budget),
    '', 'Results (each organisation ran once; differences under about 10 points may be chance):',
    ...rows.map(r => `- ${r.name}: ${r.desc}. Predicted ${r.prediction ?? '?'}, scored ${r.score ?? 'failed'}${r.minutes != null ? `, ${r.minutes} min` : ''}${r.failed?.length ? `; failed checks: ${r.failed.slice(0, 4).join('; ')}${r.failed.length > 4 ? ` (+${r.failed.length - 4} more)` : ''}` : ''}`),
    '', 'Write what you found, then propose one revised organisation to test next. Reply exactly in this shape:',
    'FOUND: at most 150 words. What did the results show, and how sure can you be?',
    'NEXT: one organisation as JSON in one ```json block, with its hypothesis in "why" and its "prediction".',
    UNATTENDED(),
  ].join('\n');
}

const reviewPrompt = (task, text) => [
  'Review this draft. It was made for this brief:', '', task.brief,
  ...(task.checks?.length ? ['', 'The app checks at the end:', ...task.checks.slice(0, 12).map(x => `- ${x.say}`)] : []),
  '', `--- draft ---\n${String(text).trim()}`, '',
  'List at most 5 concrete problems or changes, most important first. Do not rewrite it yourself.',
  UNATTENDED(),
].join('\n');

const pickPrompt = (task, pieces) => [
  `Here are ${pieces.length} pieces, each made for the same brief: ${task.brief}`, '',
  pieces.map(p => `--- ${p.letter} ---\n${p.text.trim()}`).join('\n\n'), '',
  'Which one is the best answer to the brief? Reply with one line "BEST: <letter>" and nothing else.',
  UNATTENDED(),
].join('\n');

const qualityPrompt = (task, text) => [
  `Here is a piece made for this brief: ${task.brief}`, '', `--- piece ---\n${String(text).trim()}`, '',
  'Score it from 1 to 10 for how good it is as an answer to the brief: craft, clarity, and how well it would land with someone meeting it fresh. Be strict and use the whole scale.',
  'Reply with one line "SCORE: <number> | one short reason" and nothing else.',
  UNATTENDED(),
].join('\n');

// ---- Running an organisation ----

async function execute(c, spec, task, budget, label, deps) {
  const { roomMain, ask, workerSpec, workDir, idOf } = deps;
  const pieces = {}, reviews = {}, log = [];
  const deadline = Date.now() + budget.minutes * 60000;
  const minsLeft = () => Math.max(1, Math.round((deadline - Date.now()) / 60000));
  const linesOf = id => pieces[id].lines;
  const textOf = id => pieces[id].lines.join('\n');
  const base = { ...(c.room || {}), kind: task.kind, checks: task.checks || [], lesson: false, min_moves: 0, safe_word: undefined, self_review: false };
  let n = 0;
  for (const s of spec.steps) {
    if (Date.now() > deadline && s.do !== 'pick') { log.push({ id: s.id, skipped: 'out of time' }); continue; }
    if (s.do === 'work' || s.do === 'merge') {
      const k = s.do === 'merge' ? 1 : s.agents;
      const ids = Array.from({ length: k }, () => `${workerSpec}#${++n}`);
      const others = s.do === 'merge' ? s.from.slice(1).map((f, i) => `--- other version ${i + 1} ---\n${textOf(f)}`).join('\n\n') : '';
      const note = [s.note, s.notes_from ? `A reviewer read the piece and said:\n${reviews[s.notes_from]}` : '',
        s.do === 'merge' ? `The document is one version of the piece. Combine it with these other versions: keep the best of each.\n${others}` : ''].filter(Boolean).join('\n\n');
      const from = s.do === 'merge' ? s.from[0] : s.from;
      const cfg = { ...base, title: `${label} · ${s.id}`, agents: ids, brief: task.brief, moves: s.do === 'merge' ? s.moves : s.moves,
        silent: s.do === 'merge' ? true : !s.talk, turns: s.turns !== false, versions: !!s.versions && k > 1, plan_first: !!s.plan_first && k > 1,
        words: s.words || base.words || 30, max_minutes: minsLeft(),
        start: from ? linesOf(from) : (task.start || []),
        secrets: note ? Object.fromEntries(ids.map(id => [idOf(id), note])) : {} };
      const r = await roomMain(cfg);
      pieces[s.id] = { lines: (r.out.final || []).map(l => l.text), dir: r.dir, results: r.out.results || [] };
      log.push({ id: s.id, do: s.do, dir: r.dir, seconds: Math.round(r.out.seconds || 0), moves: r.out.moves?.length ?? null,
        checks: (r.out.results || []).filter(x => x.pass).length, failed_calls: r.out.failed_calls || 0, knocked_out: r.out.knocked_out || [] });
    } else if (s.do === 'review') {
      reviews[s.id] = (await ask(`${label}-${s.id}`, reviewPrompt(task, textOf(s.from)))).trim();
      log.push({ id: s.id, do: 'review', words: words(reviews[s.id]) });
    } else if (s.do === 'pick') {
      const have = s.from.filter(f => pieces[f]);
      const ps = have.map((f, i) => ({ id: f, letter: 'ABCDEFGH'[i], text: textOf(f) }));
      const said = ps.length > 1 ? await ask(`${label}-${s.id}`, pickPrompt(task, ps)) : '';
      const best = (said.match(/BEST\s*:\s*[*_]*([A-H])/i) || [])[1];
      const got = ps.find(p => p.letter === best) || ps[0];
      if (got) pieces[s.id] = pieces[got.id];
      log.push({ id: s.id, do: 'pick', picked: got?.id || null, parsed: !!best });
    }
  }
  const fin = pieces[spec.final ?? spec.steps[spec.steps.length - 1].id] || Object.values(pieces).pop();
  return { log, final: fin || null, workDir };
}

// Share of the task's checks that the final piece passes, 0-100.
function checkScore(task, lines, check) {
  if (!task.checks?.length) return null;
  const res = task.checks.map(x => check(x, lines));
  return { score: Math.round(100 * res.filter(Boolean).length / res.length), failed: task.checks.filter((x, i) => !res[i]).map(x => x.say) };
}

function parseQuality(text) {
  const m = String(text).match(/SCORE\s*:\s*[*_]*(\d+(?:\.\d+)?)/i);
  return m ? Math.min(10, Number(m[1])) : null;
}

// A run is broken, not a result, when part of it never happened: a call that
// failed (an agent out of usage, say), a worker step with no moves or an agent
// dropped after two failed calls, a judge with no score. Broken runs stay in
// runs.json, are left out of the summary's numbers and run again next time.
function brokenWhy(row) {
  const why = [];
  if (row.callFailed) why.push(`a call failed: ${row.error || '?'}`);
  for (const s of row.steps || []) {
    if ((s.do === 'work' || s.do === 'merge') && !s.moves) why.push(`step ${s.id} made no moves`);
    else if (s.knocked_out?.length) why.push(`step ${s.id}: ${s.knocked_out.join(', ')} dropped after failed calls`);
  }
  if (row.quality && Object.values(row.quality).some(v => v == null)) why.push('a judge gave no score');
  return why;
}
const isBroken = row => brokenWhy(row).length > 0;

// ---- Kata ----

// One setting of a step, normalised so a missing switch equals "off" and a
// missing "turns" equals true (the defaults execute() uses).
const KATA_IGNORE = new Set(['id', 'name', 'why', 'prediction']);
function settingOf(k, v) {
  if (k === 'turns') return v === false ? 'false' : 'true';
  if (v == null || v === false || v === '') return 'off';
  return JSON.stringify(v);
}

// Which settings changed from one organisation to the next:
// "+step c", "-step b", "a.agents", "final". Steps are matched by id.
function specChanges(a, b) {
  const sa = new Map((a?.steps || []).map(s => [s.id, s])), sb = new Map((b?.steps || []).map(s => [s.id, s]));
  const out = [];
  for (const id of sb.keys()) if (!sa.has(id)) out.push(`+step ${id}`);
  for (const id of sa.keys()) if (!sb.has(id)) out.push(`-step ${id}`);
  for (const [id, x] of sb) {
    const y = sa.get(id); if (!y) continue;
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if (!KATA_IGNORE.has(k) && settingOf(k, x[k]) !== settingOf(k, y[k])) out.push(`${id}.${k}`);
  }
  const fin = s => s?.final ?? s?.steps?.[s.steps.length - 1]?.id;
  if (fin(a) !== fin(b)) out.push('final');
  return out;
}

// The changes that count as experiments: moves adjusted to stay in the budget
// and a "final" that only follows an added or removed step do not count.
function coreChanges(list) {
  const steps = list.some(x => /^[+-]step /.test(x));
  return list.filter(x => !/\.moves$/.test(x) && !(steps && x === 'final'));
}

// After round k scored at least `drop` below round k-1, did round k+1 keep
// round k's changes ("kept"), undo at least one of them ("undone"), or do
// something else ("other")? null when it does not apply.
function afterDrop(prev, cur, next, drop = 10) {
  if (!prev || !cur || !next || prev.score == null || cur.score == null || !next.spec || !cur.spec || !prev.spec) return null;
  if (cur.score > prev.score - drop) return null;
  const changed = specChanges(prev.spec, cur.spec);
  if (!changed.length) return null;
  const step = (sp, id) => (sp.steps || []).find(s => s.id === id);
  let undone = false, kept = true;
  for (const c of changed) {
    const m = c.match(/^([+-])step (.+)$/);
    if (m) { const inNext = !!step(next.spec, m[2]); if (m[1] === '+' ? !inNext : inNext) undone = true; continue; }
    if (c === 'final') { const f = s => s.final ?? s.steps?.[s.steps.length - 1]?.id; if (f(next.spec) === f(prev.spec)) undone = true; else if (f(next.spec) !== f(cur.spec)) kept = false; continue; }
    const [id, k] = [c.slice(0, c.indexOf('.')), c.slice(c.indexOf('.') + 1)];
    const v = sp => settingOf(k, step(sp, id)?.[k]);
    if (v(next.spec) === v(prev.spec)) undone = true;
    else if (v(next.spec) !== v(cur.spec)) kept = false;
  }
  return undone ? 'undone' : kept ? 'kept' : 'other';
}

const field = (text, name) => ((String(text).match(new RegExp(`^\\W*${name}\\s*:\\s*(.+)$`, 'im')) || [])[1] || '').trim().slice(0, 400) || null;

function historyLines(hist) {
  return hist.map(h => h.round === 1
    ? `- Round 1 (the starting point, our design): ${h.desc}. Scored ${h.score ?? 'failed'}${h.failed?.length ? `; ${h.failed.length} checks failed` : ''}.`
    : h.invalid ? `- Round ${h.round}: your organisation broke the rules, so nothing ran this round (${h.error}).`
      : `- Round ${h.round}: ${h.desc}. You expected ${h.prediction ?? '?'}, it scored ${h.score ?? 'failed'}${h.failed?.length ? `; ${h.failed.length} checks failed` : ''}.${h.learned ? ` Before it you said you had learned: "${h.learned}"` : ''}`);
}

function kataPrompt(c, task, budget, arm, hist, k, K, target) {
  const last = [...hist].reverse().find(h => h.spec && !h.invalid);
  return [
    'You are improving how a group of AI agents works on a task, round by round. Each round the app runs your organisation on a NEW instance of the same kind of task (so no answer carries over) and shows you the score. You will not do the task yourself.',
    ...goalLines(c, task, budget),
    '', 'The challenge: 100 (every check passed). You do not have to reach it in these rounds.',
    '', 'Rounds so far (each on a new instance; differences under about 10 points may be chance):', ...historyLines(hist),
    ...(target != null ? [`Your target for round ${K}: ${target}.`] : []),
    '', `The last organisation that ran, as JSON:\n\`\`\`json\n${JSON.stringify(last.spec, null, 1)}\n\`\`\``,
    '', `This is round ${k} of ${K}.`,
    ...(arm === 'free' ? [
      'Propose the organisation for this round. You may change anything.',
      'Reply exactly in this shape:', 'LEARNED: one sentence: what did the rounds so far teach you?',
      'Then the organisation as JSON in one ```json block, with "prediction" = the score you expect this round.',
    ] : [
      'Work like this, in this order:',
      ...(target == null ? [`TARGET: the score you aim for by round ${K} (one number), chosen from the rounds so far, not out of the air.`] : []),
      'LEARNED: compare what you expected with what happened in the last round. What did it teach you?',
      'OBSTACLE: the one obstacle you are working on now.',
      'CHANGE: change exactly ONE setting of the last organisation, to test against that obstacle (you may also adjust "moves" to stay in the budget). Say which setting.',
      'Then the organisation as JSON in one ```json block, with "prediction" = the score you expect this round.',
    ]),
    UNATTENDED(),
  ].join('\n');
}

const coachPrompt = (task, hist, draft) => [
  'You are a coach. Someone is improving, round by round, how a group of AI agents works on a task. You never propose solutions or settings yourself: you only ask questions.',
  `The task: ${task.short}`,
  '', 'Rounds so far (each on a new instance; differences under about 10 points may be chance):', ...historyLines(hist),
  '', `--- their draft for the next round ---\n${String(draft).trim()}`, '',
  'Ask at most 3 short questions that make them check: is it really one change? Does it follow from what the rounds so far showed, or from a single noisy number? What exactly do they expect, and why?',
  'Reply with "QUESTIONS:" and then the questions, one per line, and nothing else.',
  UNATTENDED(),
].join('\n');

const afterCoach = (prompt, draft, questions) => [
  prompt, '', `--- your first draft ---\n${String(draft).trim()}`, '',
  `A coach read your draft and asked:\n${questions}`, '',
  'First answer each question in one line, after "ANSWERS:". Then reply again in the same shape as above; you may keep your draft or change it.',
].join('\n');

function kataMd(c, runs) {
  const kr = runs.filter(r => r.level === 'kata' && !r.callFailed && !isBroken(r));
  if (!kr.length) return '';
  const K = c.kata?.rounds || 5, drop = c.kata?.drop ?? 10;
  const L = ['## Kata (round by round, a new instance every round)', '',
    `Round 1 is our design in every chain. "fixed" runs our design again every round: its spread is the noise the other arms must beat. Changes = settings changed from the round before (moves adjusted to fit the budget not counted). After a drop = a round that scored ${drop}+ below the one before: did the next round keep the change, undo it, or do something else?`, ''];
  for (const t of [...new Set(kr.map(r => r.task))]) {
    const tr = kr.filter(r => r.task === t);
    const chains = new Map();
    for (const r of tr) { const id = `${r.arm}|${r.proposer || '-'}|${r.repeat}`; if (!chains.has(id)) chains.set(id, []); chains.get(id).push(r); }
    const start = rep => tr.find(r => r.arm === 'fixed' && r.round === 1 && r.repeat === rep);
    L.push(`### ${t}`, '', `| arm | proposer | ${Array.from({ length: K }, (_, i) => `round ${i + 1}`).join(' | ')} | chains |`, `|---|---|${'---|'.repeat(K)}---|`);
    const groups = new Map();
    for (const [id, rs] of chains) { const [arm, p] = id.split('|'); const g = `${arm}|${p}`; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(rs); }
    for (const [g, cs] of groups) {
      const [arm, p] = g.split('|');
      const cell = k => { const v = cs.map(rs => k === 1 && arm !== 'fixed' ? start(rs[0].repeat)?.score : rs.find(r => r.round === k)?.score).filter(x => x != null); return v.length ? `${r1(mean(v))}` : '-'; };
      L.push(`| ${arm} | ${p} | ${Array.from({ length: K }, (_, i) => cell(i + 1)).join(' | ')} | ${cs.length} |`);
    }
    L.push('', 'Chain by chain (score, and the prediction in brackets):', '');
    for (const [id, rs] of chains) {
      const [arm, p, rep] = id.split('|');
      const seq = [...rs].sort((a, b) => a.round - b.round);
      const s0 = arm === 'fixed' ? null : start(Number(rep));
      L.push(`- ${arm} · ${p} · repeat ${rep}: ${[...(s0 ? [`r1 ${s0.score ?? '-'}`] : []), ...seq.map(r => `r${r.round} ${r.invalid ? 'rejected' : r.score ?? '-'}${r.spec?.prediction != null && arm !== 'fixed' ? ` (${r.spec.prediction})` : ''}${r.changes ? ` [${coreChanges(r.changes).length} change${coreChanges(r.changes).length === 1 ? '' : 's'}]` : ''}`)].join(' → ')}${seq.find(r => r.target != null) ? ` · target ${seq.find(r => r.target != null).target}` : ''}`);
    }
    L.push('', '| arm | proposer | mean abs prediction error, round 2 → last | changes per round: none / one / several | after a drop: kept / undone / other |', '|---|---|---|---|---|');
    for (const [g, cs] of groups) {
      const [arm, p] = g.split('|');
      if (arm === 'fixed') continue;
      const rows = cs.flat().filter(r => !r.invalid && r.score != null);
      const err = k => { const v = rows.filter(r => r.round === k && Number.isFinite(Number(r.spec?.prediction))).map(r => Math.abs(Number(r.spec.prediction) - r.score)); return v.length ? r1(mean(v)) : '-'; };
      const ch = rows.filter(r => r.changes).map(r => coreChanges(r.changes).length);
      const after = { kept: 0, undone: 0, other: 0 };
      for (const rs of cs) {
        const s0 = start(rs[0].repeat);
        const seq = [s0, ...[...rs].sort((a, b) => a.round - b.round)].filter(Boolean);
        for (let i = 1; i + 1 < seq.length; i++) { const a = afterDrop(seq[i - 1], seq[i], seq[i + 1], drop); if (a) after[a]++; }
      }
      L.push(`| ${arm} | ${p} | ${err(2)} → ${err(K)} | ${ch.filter(n => n === 0).length} / ${ch.filter(n => n === 1).length} / ${ch.filter(n => n > 1).length} | ${after.kept} / ${after.undone} / ${after.other} |`);
    }
    const fx = tr.filter(r => r.arm === 'fixed' && r.score != null).map(r => r.score);
    if (fx.length > 1) { const m = mean(fx); L.push('', `Our design run again every round ("fixed"): mean ${r1(m)}, spread (SD) ${r1(Math.sqrt(mean(fx.map(x => (x - m) ** 2))))} over ${fx.length} runs.`); }
    L.push('');
  }
  return L.join('\n');
}

// ---- Summary ----

function summaryMd(c, allRuns, labels) {
  const runs = allRuns.filter(r => r.level !== 'kata' && !r.callFailed && !isBroken(r));
  const L = [`# ${c.title}`, '', `Workers: ${c.worker}. Budget: ${c.budget.moves} moves, ${c.budget.calls} calls, at most ${c.budget.max_agents} agents per step; time box per task (${c.tasks.map(t => `${t.id} ${t.budget?.minutes ?? c.budget.minutes} min`).join(', ')}). Scores 0-100 from the app's checks${runs.some(r => r.quality != null) ? '; for the poem, half checks and half quality (blind judges, never the proposer)' : ''}.`, ''];
  for (const t of [...new Set(runs.map(r => r.task))]) {
    const tr = runs.filter(r => r.task === t);
    const rung = (l, who) => tr.filter(r => r.level === l && (!who || r.proposer === who));
    const s = xs => { const v = xs.map(r => r.score).filter(x => x != null); return v.length ? `${r1(mean(v))} (n=${v.length})` : '-'; };
    L.push(`## ${t}`, '', '| rung | proposer | score | runs |', '|---|---|---|---|',
      `| solo | - | ${s(rung('solo'))} | ${rung('solo').length} |`, `| L0 (ours) | - | ${s(rung('L0'))} | ${rung('L0').length} |`,
      ...[...new Set(tr.filter(r => r.proposer).map(r => r.proposer))].flatMap(p => [
        `| L1 | ${p} | ${s(rung('L1', p))} | ${rung('L1', p).length} |`,
        `| L3 round 1 | ${p} | ${s(tr.filter(r => r.level === 'L3' && r.round === 1 && r.proposer === p))} | ${tr.filter(r => r.level === 'L3' && r.round === 1 && r.proposer === p).length} |`,
        `| L3 round 2 | ${p} | ${s(tr.filter(r => r.level === 'L3' && r.round === 2 && r.proposer === p))} | ${tr.filter(r => r.level === 'L3' && r.round === 2 && r.proposer === p).length} |`]), '');
    const chosen = tr.filter(r => r.spec);
    if (chosen.length) {
      L.push('Organisations they chose (prediction → score):', '');
      for (const r of chosen) {
        const lab = labels?.[r.key];
        L.push(`- **${r.proposer}, ${r.level}${r.round ? ` r${r.round}` : ''}, repeat ${r.repeat}: ${r.spec.name || 'unnamed'}** · ${r.desc} · predicted ${r.spec.prediction ?? '?'}, scored ${r.score ?? 'failed'}${lab ? ` · human-like: ${lab}` : ''}${r.spec.why ? ` · why: ${r.spec.why}` : ''}${r.error ? ` · error: ${r.error}` : ''}`);
      }
      const err = chosen.filter(r => r.score != null && Number.isFinite(Number(r.spec.prediction))).map(r => Number(r.spec.prediction) - r.score);
      if (err.length) L.push('', `Prediction minus score: mean ${r1(mean(err))}, mean absolute ${r1(mean(err.map(Math.abs)))} (n=${err.length}). Positive = they expected more than they got.`);
      L.push('');
    }
    for (const r of tr.filter(r => r.found)) L.push(`**${r.proposer} found (${t}):** ${r.found}`, '');
    const bad = tr.filter(r => r.invalid);
    if (bad.length) L.push(`Specs rejected after one correction: ${bad.map(r => `${r.proposer} (${r.level})`).join(', ')}.`, '');
  }
  const bad = allRuns.filter(r => r.callFailed || isBroken(r));
  const tailMd = bad.length ? ['', `## Broken runs (${bad.length}, left out above; they run again next time)`, '', ...bad.map(r => `- ${r.key}: ${brokenWhy(r).join('; ')}`), ''].join('\n') : '';
  return L.join('\n') + (allRuns.some(r => r.level === 'kata') ? '\n' + kataMd(c, allRuns) : '') + tailMd;
}

// ---- Main ----

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  if (!file) { console.error('usage: node organise.js <organise.json> [--tasks a,b] [--out=<folder>]'); process.exit(2); }
  const flag = n => (args.find(a => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
  const c = { title: 'The agents choose how to work together', repeats: 2, levels: ['solo', 'L0', 'L1', 'L3'], l3: { n: 3 }, judges: ['claude', 'codex'], ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  c.budget = { moves: 16, calls: 20, minutes: 10, max_agents: 4, max_steps: 8, ...(c.budget || {}) };
  const onlyTasks = flag('tasks') ? flag('tasks').split(',') : null;
  const cfgAll = loadConfig();
  const room = require('./room');
  const { run } = require('./motion');
  const agent = id => room.resolveAgent(cfgAll.agents.filter(x => x.type !== 'url'), id);
  const out = flag('out') ? path.resolve(flag('out').replace(/^~/, os.homedir())) : path.join(HOME_DIR, 'organise', `${stamp()}-${crypto.randomBytes(2).toString('hex')}`);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'config.json'), JSON.stringify(c, null, 2));
  console.log(`Organise: ${out}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'organise-'));
  const runsFile = path.join(out, 'runs.json');
  const runs = fs.existsSync(runsFile) ? JSON.parse(fs.readFileSync(runsFile, 'utf8')) : [];
  const save = () => { fs.writeFileSync(runsFile, JSON.stringify(runs, null, 2)); fs.writeFileSync(path.join(out, 'summary.md'), summaryMd(c, runs, null)); };
  const done = key => runs.some(r => r.key === key && !r.error && !isBroken(r));
  const worker = agent(c.worker);
  const calls = {};
  const ask = (name, prompt, who = worker) => { calls[who.base || who.id] = (calls[who.base || who.id] || 0) + 1; return run(out, name, who, prompt, work); };
  const deps = { roomMain: room.main, ask: (n, p) => ask(n, p), workerSpec: c.worker, workDir: work, idOf: id => agent(id).id };
  const t0 = Date.now(), started = new Date().toISOString();

  // One short call to every model first: one that doesn't answer (out of
  // usage, signed out) stops the run before it fills hours with broken runs.
  if (c.ping !== false) {
    const ids = [...new Set([c.worker, ...(c.proposers || []), ...(c.judges || []), ...(c.kata?.coach && c.kata.coach !== 'other' ? [c.kata.coach] : [])])];
    const dead = [];
    for (const id of ids) {
      try { await run(out, `ping-${agent(id).id}`, agent(id), 'Reply with the single word OK.', work); }
      catch (e) { dead.push(`${id}: ${e.message.split('\n').slice(0, 3).join(' ')}`); }
    }
    if (dead.length) { console.error(`Not starting: ${dead.length} agent(s) did not answer:\n${dead.map(d => `- ${d}`).join('\n')}`); process.exit(3); }
  }

  // Ask a proposer for spec(s); one correction if a spec breaks the rules.
  async function propose(p, name, prompt, many) {
    let text = await ask(name, prompt, agent(p));
    let specs = parseSpecs(text);
    const check = () => specs.map(s => validate(s, c.budget));
    let v = check();
    if (!specs.length || v.some(x => !x.ok) || (many && specs.length < 2)) {
      const why = !specs.length ? ['No organisation could be read: reply with JSON in one ```json block.'] : v.flatMap((x, i) => x.errors.map(e => `${specs.length > 1 ? `Organisation ${i + 1}: ` : ''}${e}`));
      text = await ask(`${name}-fix`, `${prompt}\n\nYour previous reply broke these rules:\n${why.map(e => `- ${e}`).join('\n')}\nReply again, corrected, in the same format.`, agent(p));
      specs = parseSpecs(text); v = check();
    }
    return specs.map((s, i) => ({ spec: s, ok: v[i]?.ok, errors: v[i]?.errors || [], text }));
  }

  async function runOrg(key, base, spec, task, label) {
    if (done(key)) return runs.find(r => r.key === key);
    const row = { key, ...base, spec, desc: spec ? describe(spec) : null };
    const t = Date.now();
    try {
      const res = await execute(c, spec, task, c.budget, label, deps);
      const lines = res.final?.lines || [];
      fs.writeFileSync(path.join(out, `${key}.txt`), lines.join('\n') + '\n');
      const cs = checkScore(task, lines, (x, ls) => room.check(x, ls.map(text => ({ text }))));
      row.checks = cs?.score ?? null; row.failed = cs?.failed || [];
      row.steps = res.log; row.minutes = r1((Date.now() - t) / 60000);
      if (task.judge && lines.length) {
        row.quality = {};
        for (const jid of c.judges) {
          if (base.proposer && agent(jid).base === agent(base.proposer).base) continue; // never judges its own organisation
          try { row.quality[jid] = parseQuality(await ask(`quality-${key}-${jid}`, qualityPrompt(task, lines.join('\n')), agent(jid))); } catch (e) { row.quality[jid] = null; }
        }
        const q = mean(Object.values(row.quality).filter(x => x != null));
        row.score = q == null ? row.checks : Math.round((row.checks + q * 10) / 2);
      } else row.score = row.checks;
    } catch (e) { row.error = e.message.split('\n')[0]; console.error(`  ✗ ${key}: ${row.error}`); }
    const bw = brokenWhy(row);
    if (bw.length) { row.broken = bw; console.error(`  ✗ ${key} broken: ${bw.join('; ')}`); }
    const i = runs.findIndex(r => r.key === key); if (i >= 0) runs.splice(i, 1, row); else runs.push(row);
    save();
    return row;
  }

  const solo = { name: 'solo', steps: [{ id: 'a', do: 'work', agents: 1, moves: c.budget.moves, talk: false, turns: true }], final: 'a' };
  const budget0 = c.budget;
  for (const tdef of c.tasks.filter(t => !onlyTasks || onlyTasks.includes(t.id))) {
    c.budget = { ...budget0, ...(tdef.budget || {}) }; // a task may set its own time box
    for (let r = 0; r < c.repeats; r++) {
      const task = taskFor(tdef, r + 1);
      const tag = `${tdef.id}-r${r + 1}`;
      console.log(`\n== ${tag}`);
      if (c.levels.includes('solo')) await runOrg(`${tag}-solo`, { task: tdef.id, repeat: r + 1, level: 'solo' }, solo, task, `${tag} solo`);
      if (c.levels.includes('L0') && tdef.l0) await runOrg(`${tag}-L0`, { task: tdef.id, repeat: r + 1, level: 'L0' }, tdef.l0, task, `${tag} L0`);
      if (c.levels.includes('L1')) for (const p of c.proposers) {
        const key = `${tag}-L1-${agent(p).id}`;
        if (done(key)) continue;
        let got;
        try { got = (await propose(p, `propose-${key}`, l1Prompt(c, task, c.budget), false))[0]; } catch (e) { got = { errors: [e.message.split('\n')[0]], callFailed: true }; }
        if (!got?.ok) { const row = { key, task: tdef.id, repeat: r + 1, level: 'L1', proposer: p, spec: got?.spec || null, invalid: true, error: (got?.errors || ['no spec']).join(' '), ...(got?.callFailed ? { callFailed: true } : {}) }; const i = runs.findIndex(x => x.key === key); if (i >= 0) runs.splice(i, 1, row); else runs.push(row); save(); continue; }
        await runOrg(key, { task: tdef.id, repeat: r + 1, level: 'L1', proposer: p }, got.spec, task, `${tag} L1 ${p}`);
      }
    }
    // L3: one research campaign per proposer, on repeat 1's task, with solo and L0 of that repeat as context.
    if (c.levels.includes('L3')) {
      const task = taskFor(tdef, 1), tag = `${tdef.id}-r1`;
      for (const p of c.proposers) {
        const pid = agent(p).id;
        let props = runs.filter(x => x.key.startsWith(`${tag}-L3-${pid}-r1-`));
        if (props.some(x => x.callFailed)) { for (const x of props) runs.splice(runs.indexOf(x), 1); props = []; } // the proposal itself failed: ask again
        let redone = false;
        for (const x of props.filter(x => !x.invalid && x.spec && (x.error || isBroken(x)))) {
          redone = true;
          await runOrg(x.key, { task: tdef.id, repeat: 1, level: 'L3', round: 1, proposer: p }, x.spec, task, `${tag} L3 ${p} ${x.key.split('-').pop()}`);
        }
        props = runs.filter(x => x.key.startsWith(`${tag}-L3-${pid}-r1-`));
        if (done(`${tag}-L3-${pid}-r2`) && !redone && props.length) continue;
        if (!props.length) {
          let got = [];
          try { got = await propose(p, `propose-${tag}-L3-${pid}`, l3Prompt(c, task, c.budget), true); } catch (e) {
            const error = e.message.split('\n')[0]; console.error(`  ✗ L3 ${p}: ${error}`);
            runs.push({ key: `${tag}-L3-${pid}-r1-1`, task: tdef.id, repeat: 1, level: 'L3', round: 1, proposer: p, invalid: true, callFailed: true, error }); save(); continue;
          }
          for (const [i, g] of got.slice(0, c.l3.n || 3).entries()) {
            const key = `${tag}-L3-${pid}-r1-${i + 1}`;
            if (!g.ok) { runs.push({ key, task: tdef.id, repeat: 1, level: 'L3', round: 1, proposer: p, spec: g.spec, invalid: true, error: g.errors.join(' ') }); save(); continue; }
            await runOrg(key, { task: tdef.id, repeat: 1, level: 'L3', round: 1, proposer: p }, g.spec, task, `${tag} L3 ${p} ${i + 1}`);
          }
          props = runs.filter(x => x.key.startsWith(`${tag}-L3-${pid}-r1-`));
        }
        const context = runs.filter(x => x.key === `${tag}-solo` || x.key === `${tag}-L0`).map(x => ({ name: x.level === 'solo' ? 'one agent alone (ours, for comparison)' : 'our own design (for comparison)', desc: x.desc, prediction: null, score: x.score, minutes: x.minutes, failed: x.failed }));
        const rows = [...props.map(x => ({ name: x.spec?.name || x.key, desc: x.desc || '(rejected)', prediction: x.spec?.prediction, score: x.invalid ? null : x.score, minutes: x.minutes, failed: x.failed })), ...context];
        let text = '';
        try { text = await ask(`report-${tag}-L3-${pid}`, reportPrompt(c, task, c.budget, rows), agent(p)); } catch (e) {
          const error = e.message.split('\n')[0]; console.error(`  ✗ report ${p}: ${error}`);
          const key = `${tag}-L3-${pid}-r2`, row = { key, task: tdef.id, repeat: 1, level: 'L3', round: 2, proposer: p, invalid: true, callFailed: true, error };
          const i = runs.findIndex(x => x.key === key); if (i >= 0) runs.splice(i, 1, row); else runs.push(row); save(); continue;
        }
        const found = ((text.match(/FOUND\s*:\s*([\s\S]*?)(?:\n\s*NEXT\s*:|$)/i) || [])[1] || '').trim();
        fs.writeFileSync(path.join(out, `report-${tdef.id}-${pid}.md`), text);
        const next = parseSpecs(text)[0];
        const v = next ? validate(next, c.budget) : { ok: false, errors: ['no organisation in NEXT'] };
        const key = `${tag}-L3-${pid}-r2`;
        if (!v.ok) { const row = { key, task: tdef.id, repeat: 1, level: 'L3', round: 2, proposer: p, spec: next || null, found, invalid: true, error: v.errors.join(' ') }; const i = runs.findIndex(x => x.key === key); if (i >= 0) runs.splice(i, 1, row); else runs.push(row); save(); continue; }
        await runOrg(key, { task: tdef.id, repeat: 1, level: 'L3', round: 2, proposer: p, found }, next, task, `${tag} L3 ${p} round 2`);
      }
    }
  }

  // Kata: round by round, a new instance every round (see the top of the file).
  if (c.levels.includes('kata')) {
    const kc = { rounds: 5, arms: ['fixed', 'free', 'kata', 'coach'], coach: 'other', drop: 10, ...(c.kata || {}) };
    c.kata = kc;
    const K = kc.rounds;
    const coachOf = p => kc.coach === 'other' ? c.proposers[(c.proposers.indexOf(p) + 1) % c.proposers.length] : kc.coach;
    for (const tdef of c.tasks.filter(t => !onlyTasks || onlyTasks.includes(t.id))) {
      c.budget = { ...budget0, ...(tdef.budget || {}) };
      if (!tdef.l0) { console.error(`  ✗ kata ${tdef.id}: needs an "l0" design as round 1`); continue; }
      for (let r = 0; r < c.repeats; r++) {
        const tag = `${tdef.id}-r${r + 1}`;
        const inst = k => taskFor(tdef, `${r + 1}-k${k}`); // a new instance every round, the same for every chain of this repeat
        console.log(`\n== ${tag} kata`);
        for (let k = 1; k <= K; k++) if (k === 1 || kc.arms.includes('fixed'))
          await runOrg(`${tag}-kata-fixed-k${k}`, { task: tdef.id, repeat: r + 1, level: 'kata', arm: 'fixed', round: k }, tdef.l0, inst(k), `${tag} kata fixed k${k}`);
        const start = runs.find(x => x.key === `${tag}-kata-fixed-k1`);
        const histOf = row => ({ round: row.round, spec: row.spec, desc: row.desc, score: row.invalid ? null : row.score, failed: row.failed, prediction: row.spec?.prediction, learned: row.learned, invalid: row.invalid, error: row.error });
        for (const p of c.proposers) for (const arm of kc.arms.filter(a => a !== 'fixed')) {
          const pid = agent(p).id, chain = `${tag}-kata-${arm}-${pid}`;
          const hist = [histOf({ ...start, round: 1 })];
          let target = null, redo = isBroken(start) || !!start.error;
          for (let k = 2; k <= K; k++) {
            const key = `${chain}-k${k}`;
            // A round is kept only if it and every round before it really happened:
            // a later round was chosen from the earlier ones' results.
            const had = runs.find(x => x.key === key && !(x.error && !x.invalid) && !isBroken(x));
            if (had && !redo) { hist.push(histOf(had)); target ??= had.target ?? null; continue; }
            redo = true;
            const task = inst(k);
            const prompt = kataPrompt(c, task, c.budget, arm, hist, k, K, target);
            const base = { task: tdef.id, repeat: r + 1, level: 'kata', arm, round: k, proposer: p };
            let got, questions = null, answers = null;
            try {
              if (arm === 'coach') {
                const coach = coachOf(p);
                const draft = await ask(`kata-${key}-draft`, prompt, agent(p));
                questions = (String(await ask(`kata-${key}-coach`, coachPrompt(task, hist, draft), agent(coach))).split(/QUESTIONS\s*:/i).pop() || '').trim().split('\n').filter(l => l.trim()).slice(0, 3).join('\n');
                base.coach = coach;
                got = (await propose(p, `kata-${key}`, afterCoach(prompt, draft, questions), false))[0];
                answers = got ? (String(got.text).match(/ANSWERS\s*:\s*([\s\S]*?)(?:\n\s*(?:TARGET|LEARNED)\s*:|$)/i) || [])[1]?.trim().slice(0, 600) || null : null;
              } else got = (await propose(p, `kata-${key}`, prompt, false))[0];
            } catch (e) { got = { errors: [e.message.split('\n')[0]], callFailed: true }; }
            const text = got?.text || '';
            const notes = { learned: field(text, 'LEARNED'), obstacle: field(text, 'OBSTACLE'), change: field(text, 'CHANGE'), questions, answers };
            if (target == null && arm !== 'free') { const t = Number((field(text, 'TARGET') || '').match(/\d+(?:\.\d+)?/)?.[0]); if (Number.isFinite(t)) target = t; }
            const prev = [...hist].reverse().find(h => h.spec && !h.invalid);
            if (!got?.ok) {
              const row = { key, ...base, ...notes, target, spec: got?.spec || null, invalid: true, error: (got?.errors || ['no spec']).join(' '), ...(got?.callFailed ? { callFailed: true } : {}) };
              const i = runs.findIndex(x => x.key === key); if (i >= 0) runs.splice(i, 1, row); else runs.push(row);
              save(); hist.push(histOf(row)); continue;
            }
            const row = await runOrg(key, { ...base, ...notes, target, changes: specChanges(prev.spec, got.spec) }, got.spec, task, `${tag} kata ${arm} ${p} k${k}`);
            hist.push(histOf(row));
          }
        }
      }
    }
    c.budget = budget0;
  }

  // How human the chosen organisations look: the same blind labels as ideate.js.
  let labels = null;
  if (c.label_with) {
    try {
      const ideate = require('./ideate');
      const ic = JSON.parse(fs.readFileSync(path.resolve(path.dirname(file), c.label_with), 'utf8'));
      const chosen = runs.filter(r => r.spec && r.proposer && r.level !== 'kata');
      const items = chosen.map((r, i) => ({ n: i + 1, idea: r.spec.name || 'unnamed', mechanism: r.desc || '', not_human: r.spec.why || '' }));
      const got = ideate.parseLabels(await ask('label-orgs', ideate.labelPrompt(ic, items), agent(c.judges[0])));
      labels = Object.fromEntries(chosen.map((r, i) => [r.key, got[i + 1]?.human || null]));
    } catch (e) { console.error(`  ✗ labels: ${e.message.split('\n')[0]}`); }
  }
  let spent = null;
  try { spent = require('./openrouter').spent(started); } catch {}
  fs.writeFileSync(path.join(out, 'summary.md'), summaryMd(c, runs, labels) +
    `\n## Cost and time\n\n${Math.round((Date.now() - t0) / 60000)} minutes this session. Proposer, review, pick and judge calls this session: ${Object.entries(calls).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'} (Gemini ≈ £0.03 a call, estimate; room moves not counted here). OpenRouter reported: $${(spent || 0).toFixed(4)}. Workers on subscription.\n`);
  console.log(`\n${path.join(out, 'summary.md')}`);
  // Broken runs make the whole job fail, so the night queue runs it again
  // (the work that did happen is kept).
  const broken = runs.filter(r => r.callFailed || r.error && !r.invalid || isBroken(r));
  if (broken.length) {
    console.error(`${broken.length} of ${runs.length} runs are broken or failed; run again to redo them:\n${broken.slice(0, 10).map(r => `- ${r.key}: ${(brokenWhy(r).join('; ') || r.error || '').slice(0, 160)}`).join('\n')}`);
    process.exitCode = 1;
  }
}

module.exports = { parseSpecs, validate, describe, execute, checkScore, taskFor, summaryMd, l1Prompt, l3Prompt, reportPrompt, parseQuality,
  specChanges, coreChanges, afterDrop, kataPrompt, coachPrompt, kataMd, brokenWhy };

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
