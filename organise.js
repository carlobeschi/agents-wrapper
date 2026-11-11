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
        checks: (r.out.results || []).filter(x => x.pass).length });
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

// ---- Summary ----

function summaryMd(c, runs, labels) {
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
  return L.join('\n');
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
  const done = key => runs.some(r => r.key === key && !r.error);
  const worker = agent(c.worker);
  const calls = {};
  const ask = (name, prompt, who = worker) => { calls[who.base || who.id] = (calls[who.base || who.id] || 0) + 1; return run(out, name, who, prompt, work); };
  const deps = { roomMain: room.main, ask: (n, p) => ask(n, p), workerSpec: c.worker, workDir: work, idOf: id => agent(id).id };
  const t0 = Date.now(), started = new Date().toISOString();

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
    return specs.map((s, i) => ({ spec: s, ok: v[i]?.ok, errors: v[i]?.errors || [] }));
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
        try { got = (await propose(p, `propose-${key}`, l1Prompt(c, task, c.budget), false))[0]; } catch (e) { got = { errors: [e.message.split('\n')[0]] }; }
        if (!got?.ok) { runs.push({ key, task: tdef.id, repeat: r + 1, level: 'L1', proposer: p, spec: got?.spec || null, invalid: true, error: (got?.errors || ['no spec']).join(' ') }); save(); continue; }
        await runOrg(key, { task: tdef.id, repeat: r + 1, level: 'L1', proposer: p }, got.spec, task, `${tag} L1 ${p}`);
      }
    }
    // L3: one research campaign per proposer, on repeat 1's task, with solo and L0 of that repeat as context.
    if (c.levels.includes('L3')) {
      const task = taskFor(tdef, 1), tag = `${tdef.id}-r1`;
      for (const p of c.proposers) {
        const pid = agent(p).id;
        if (done(`${tag}-L3-${pid}-r2`)) continue;
        let props = runs.filter(x => x.key.startsWith(`${tag}-L3-${pid}-r1-`));
        if (!props.length) {
          let got = [];
          try { got = await propose(p, `propose-${tag}-L3-${pid}`, l3Prompt(c, task, c.budget), true); } catch (e) { console.error(`  ✗ L3 ${p}: ${e.message.split('\n')[0]}`); }
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
        try { text = await ask(`report-${tag}-L3-${pid}`, reportPrompt(c, task, c.budget, rows), agent(p)); } catch (e) { console.error(`  ✗ report ${p}: ${e.message.split('\n')[0]}`); }
        const found = ((text.match(/FOUND\s*:\s*([\s\S]*?)(?:\n\s*NEXT\s*:|$)/i) || [])[1] || '').trim();
        fs.writeFileSync(path.join(out, `report-${tdef.id}-${pid}.md`), text);
        const next = parseSpecs(text)[0];
        const v = next ? validate(next, c.budget) : { ok: false, errors: ['no organisation in NEXT'] };
        const key = `${tag}-L3-${pid}-r2`;
        if (!v.ok) { runs.push({ key, task: tdef.id, repeat: 1, level: 'L3', round: 2, proposer: p, spec: next || null, found, invalid: true, error: v.errors.join(' ') }); save(); continue; }
        await runOrg(key, { task: tdef.id, repeat: 1, level: 'L3', round: 2, proposer: p, found }, next, task, `${tag} L3 ${p} round 2`);
      }
    }
  }

  // How human the chosen organisations look: the same blind labels as ideate.js.
  let labels = null;
  if (c.label_with) {
    try {
      const ideate = require('./ideate');
      const ic = JSON.parse(fs.readFileSync(path.resolve(path.dirname(file), c.label_with), 'utf8'));
      const chosen = runs.filter(r => r.spec && r.proposer);
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
}

module.exports = { parseSpecs, validate, describe, execute, checkScore, taskFor, summaryMd, l1Prompt, l3Prompt, reportPrompt, parseQuality };

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
