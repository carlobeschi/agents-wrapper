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

  const together = (t, extra = {}) => {
    const r = asRoom(t), min = minOf(t);
    return { ...base, ...r, agents: agents.map(a => specs[a.id]), ...extra, lesson: true, min_moves: min,
      brief: `${r.brief} ${PAIR()}${min ? ` ${extra.readonly?.length ? 'Each of you who edits' : 'Each of you'} must change it at least ${min} times.` : ''}` };
  };
  const repeats = cfg.repeats || 1;
  const processJudges = (cfg.process_judges || []).map(pick);
  async function processLabels(runDir, name) {
    const tl = JSON.parse(fs.readFileSync(path.join(runDir, 'timeline.json'), 'utf8'));
    if (tl.agents.length < 2) return null;
    const text = transcript(tl), out = [];
    for (const j of processJudges) {
      try { out.push({ judge: j.id, ...parseProcess(await run(dir, `process-${name}-${j.id}`, j, processPrompt(text), path.join(runDir, 'cwd'))) }); }
      catch (e) { out.push({ judge: j.id, error: e.message.split('\n')[0] }); }
    }
    return out;
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
        const ids = agents.map(a => a.id), k = r % ids.length, order = ids.slice(k).concat(ids.slice(0, k));
        for (const v of cfg.variants) {
          if (v.only && !v.only.includes(t.id)) continue;
          const extra = { title: `${t.id} · ${v.label}`, ...(v.room || {}), agents: order.map(id => specs[id]) };
          if (v.roles) {
            extra.roles = Object.fromEntries(order.map((id, i) => [id, v.roles[Math.min(i, v.roles.length - 1)]]));
            if (v.checker) extra.readonly = order.filter((id, i) => Math.min(i, v.roles.length - 1) === v.roles.length - 1);
          }
          console.log(`- ${v.label} (${order.join(' first, ')})`);
          const got = await roomRun(together(t, extra), t);
          got.starter = order[0];
          got.stats = JSON.parse(fs.readFileSync(path.join(got.dir, 'timeline.json'), 'utf8')).stats || null;
          got.process = await processLabels(got.dir, `${t.id}-${r + 1}-${v.label.replace(/\W+/g, '-')}`);
          runs[v.label] = got;
          save();
        }
        task.repeats[r].judgings = t.judge === false ? [] : await judgeSet(dir, `${t.id}-${r + 1}`, t.kind, t.brief || asRoom(t).brief, Object.entries(runs).map(([label, x]) => ({ label, dir: x.dir })), judges);
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

module.exports = { shuffle, parseScores, judgePrompt, summaryMd, transcript, parseProcess, main };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node study.js <study.json>'); process.exit(2); }
  main(file).catch(e => { console.error(e.message); process.exit(1); });
}
