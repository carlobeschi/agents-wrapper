#!/usr/bin/env node
// @ts-check
// Study 16, the double diamond: `node diamond.js <config.json> [--out=<folder>] [--runs=a,b] [--no-preflight]`.
//
// One shared goal (write the controller of four elevators, elevator.js) and
// several ways for a group of agents to reach it, at about the same number of
// calls (~40), scored by the script on days nobody saw:
//
//   diamond    (Carlo's napkin, 21 Nov) every agent proposes approaches alone
//              (diverge); everyone scores every idea, anonymous and shuffled;
//              the script keeps the best few by the votes of the others, with
//              no manager (converge); each kept idea is built by its author
//              and a partner of another vendor, taking turns (diverge again);
//              everyone scores the prototypes; the winner is refined.
//   alone      every agent writes and improves its own controller, alone; the
//              script keeps the best on the visible days and its author
//              refines it. With nine copies of one model this is "the best of
//              N" a single agent gets with the same budget.
//   orchestra  a lead splits the job into parts, workers write the parts, the
//              lead puts them together, then a few rounds of "lead says what
//              to fix, workers fix, lead puts together".
//
// The agents write text and code only. The script runs every version of the
// controller in a sandbox (proof_wrap) on the visible days and shows them the
// result; the final controller, and every prototype or candidate, is also
// run on the hidden days, which no prompt ever shows. "Best version" always
// means best on the visible days, the same rule in every arm.
//
// What is measured (room/doppio-diamante-design.md, preregistered in
// lab/influence-plan.md row 16): the final gain on hidden days per arm; for
// diamonds, whether the group's winner is the best of its prototypes on hidden
// days, how far it is from that best, how votes go to one's own vendor, and
// how many families of ideas two outside judges find among the first ideas.
//
// Config (examples/diamond/elevator.json):
// { "title": "...", "goal": "one paragraph for the agents",
//   "instances": [{ "name": "i1", "visible": [days], "hidden": [days] }],
//   "arms": { "D-mix": { "mode": "diamond", "agents": ["claude#1", ...] },
//             "N-solo": { "mode": "alone", "agents": [...] },
//             "O": { "mode": "orchestra", "lead": "claude#1", "agents": [...] } },
//   "repeats": 2, "ideas_per_agent": 2, "shortlist": 4, "build_rounds": 3,
//   "alone_rounds": 4, "refine_rounds": 3, "orchestra_cycles": 4, "orchestra_fixers": 6,
//   "parallel": 3, "judges": ["openrouter:...", ...], "proof_wrap": ["codex", "sandbox", "--"] }
// A day is { "kind": "up" | "down" | "lunch" | "inter", "seed": n, "intensity"?: x }.
// Run folder: ~/.agent-dispatch/diamond/<run>/ (or --out): summary.md,
// results.json, one folder per run (run.json, steps/, versions/). Every
// agent's reply is kept, so a stopped run starts again where it was with the
// same --out; a run with run.json is done. Nothing is published from here.

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { HOME_DIR, loadConfig: loadAgents, stamp } = require('./config');
const { run } = require('./motion');
const { sandboxed, splitReply, PROOF_WRAP } = require('./wrongnote');
const { resolveAgent } = require('./room');
const { BRIEF, rng } = require('./elevator');

const MAX_CODE = 20000;
const MODES = ['diamond', 'alone', 'orchestra'];
const DEFAULT_JUDGES = ['openrouter:deepseek/deepseek-v4-pro-0813', 'openrouter:qwen/qwen3.8-max-0902'];

// ---- Small helpers ----

const seedOf = s => crypto.createHash('sha256').update(String(s)).digest().readUInt32LE(0);
function shuffled(list, seed) {
  const r = rng(seedOf(seed)), a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const rotate = (list, k) => list.map((_, i) => list[(i + k) % list.length]);
const mean = xs => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
// How alike two controllers are: Jaccard overlap of their sets of words and names (0 = nothing shared, 1 = the same).
const tokens = code => new Set(String(code || '').match(/[A-Za-z_$][\w$]*|\d+/g) || []);
function similarity(a, b) {
  const x = tokens(a), y = tokens(b);
  if (!x.size && !y.size) return null;
  let both = 0;
  for (const t of x) if (y.has(t)) both++;
  return both / (x.size + y.size - both);
}
const meanPairwise = codes => {
  const sims = [];
  for (let i = 0; i < codes.length; i++) for (let j = i + 1; j < codes.length; j++) if (codes[i] && codes[j]) sims.push(similarity(codes[i], codes[j]));
  return mean(sims.filter(x => x !== null));
};
const round2 = x => x === null || x === undefined ? null : Math.round(x * 100) / 100;

async function pool(items, n, fn) {
  let i = 0;
  const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ---- Parsing what agents wrote ----

// "IDEA 1: title" starts an idea; everything up to the next one is its text.
function parseIdeas(text, max) {
  const parts = String(text).split(/^[ \t>*_#`]*IDEA[ \t]*\d+[*_`]*[ \t]*[:.)-]/im).slice(1).map(s => s.replace(/^[*_`]+/, '').trim()).filter(Boolean);
  if (!parts.length && String(text).trim()) parts.push(String(text).trim());
  return parts.slice(0, max).map(s => plain(s).slice(0, 2000));
}

// Ideas are shown to voters in one plain style, so formatting habits (bold,
// headings, bullets, emoji) give away less of who wrote them.
function plain(text) {
  return String(text)
    .replace(/[*_`#>~]+/g, '')
    .replace(/^[ \t]*(?:[-•+]|\d+[.)])[ \t]+/gm, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// One line per item: "3: 7 - reason" (or "IDEA 3: 7", "PROTOTYPE 3 - 7/10"). Returns { [n]: score }.
function parseScores(text, n) {
  const out = {};
  for (const m of String(text).matchAll(/^[ \t>*_`#-]*(?:IDEA|PROTOTYPE)?[ \t]*(\d+)[*_`]*[ \t]*[:.)=-]+[ \t]*[*_`]*[ \t]*(\d+(?:\.\d+)?)(?:[ \t]*\/[ \t]*10)?/gim)) {
    const k = Number(m[1]), s = Number(m[2]);
    if (k >= 1 && k <= n && s >= 0 && s <= 10 && !(k in out)) out[k] = s;
  }
  return out;
}

// "PART 2: what to write" lines of the lead's plan.
function parseParts(text, max) {
  return [...String(text).matchAll(/^[ \t>*_`#-]*PART[ \t]*(\d+)[*_`]*[ \t]*[:.)-][ \t]*(.+)$/gim)].map(m => m[2].trim()).filter(Boolean).slice(0, max);
}

// "FIX 2: what to change" lines: the part number and the instruction.
function parseFixes(text, parts, max) {
  const seen = new Set(), out = [];
  for (const m of String(text).matchAll(/^[ \t>*_`#-]*FIX[ \t]*(\d+)[*_`]*[ \t]*[:.)-][ \t]*(.+)$/gim)) {
    const k = Number(m[1]);
    if (k >= 1 && k <= parts && !seen.has(k)) { seen.add(k); out.push({ part: k, fix: m[2].trim() }); }
  }
  return out.slice(0, max);
}

// "FAMILY: 1, 4, 7 | name" lines: groups of idea numbers.
function parseFamilies(text, n) {
  const groups = [];
  for (const m of String(text).matchAll(/^[ \t>*_`#-]*FAMILY[^:\n]*:[ \t]*([\d,\s]+)(?:\|(.*))?$/gim)) {
    const ids = [...new Set(m[1].split(/[,\s]+/).filter(Boolean).map(Number).filter(k => k >= 1 && k <= n))];
    if (ids.length) groups.push({ ids, name: (m[2] || '').trim() });
  }
  return groups;
}

const codeOf = text => {
  const { code } = splitReply(text);
  return code && code.length <= MAX_CODE ? code : null;
};

// ---- Prompts ----

const task = c => `${c.goal}\n\n${BRIEF}`;
const FILE_RULE = `End your reply with the whole controller.js in one \`\`\`js block (at most ${MAX_CODE} characters). Write nothing after it.`;

function resultLine(v) {
  if (!v) return '(not run yet)';
  const days = v.days.map(d => `${d.name}: ${d.journey} s vs baseline ${d.baseline} s (${d.gain >= 0 ? '+' : ''}${d.gain}%), delivered ${d.delivered}/${d.people}${d.errors ? `, ${d.errors} step errors (first: ${d.first_error})` : ''}${d.stopped ? `, STOPPED: ${d.stopped}` : ''}`);
  return `Gain on the visible days: ${v.gain >= 0 ? '+' : ''}${v.gain}%\n${days.map(d => `- ${d}`).join('\n')}`;
}

function divergePrompt(c) {
  return `${task(c)}

You are one of several agents working on this goal. Everyone thinks alone first; later everyone will see all the ideas, without names, and score them.
Propose ${c.ideas_per_agent} approaches that are really different from each other (not two versions of one idea). No code yet.
For each, start a line with "IDEA <n>:" and a short title, then at most 120 words: how the controller decides, and why it should beat the baseline on these days.`;
}

function critiquePrompt(c, ideas) {
  return `${task(c)}

Below are ${ideas.length} ideas for this controller, written by different agents (maybe one of them by you), in random order, without names.
Score each from 0 to 10: how much shorter would journeys get, once it is built and debugged in a few tries? Be strict and use the whole range.
Answer with exactly one line per idea, "<n>: <score> - <reason in at most 20 words>", for all ${ideas.length}.

${ideas.map((t, i) => `IDEA ${i + 1}:\n${t}`).join('\n\n')}`;
}

function sharedBlock(shown) {
  if (!shown || !shown.list.length) return '';
  const head = shown.mode === 'drafts'
    ? 'The group is building other prototypes, of other approaches, at the same time. Where they are now, with their code:'
    : 'The group is building other prototypes, of other approaches, at the same time. Where they are now (approach and result only):';
  return `${head}\n\n${shown.list.map((o, i) => `OTHER PROTOTYPE ${i + 1}\nApproach:\n${o.idea}\n\n${resultLine(o.result)}${shown.mode === 'drafts' ? `\n\n\`\`\`js\n${o.code || '// (no working code)\n'}\`\`\`` : ''}`).join('\n\n')}\n\nUse them as you see fit.\n\n`;
}

function buildPrompt(c, idea, current, result, round, shown = null) {
  return `${task(c)}

Your group chose this approach to build:
${idea}

${sharedBlock(shown)}
${current ? `This is version ${round - 1} of the prototype (written by someone in the group), with its result:\n\n\`\`\`js\n${current}\`\`\`\n\n${resultLine(result)}\n\nImprove it while keeping to the approach: fix what is wrong, make journeys shorter.` : 'Write the first version of this prototype.'}
${FILE_RULE}`;
}

function prototypesPrompt(c, protos) {
  return `${task(c)}

Your group built ${protos.length} prototypes of different approaches. Below, in random order and without names, each with its approach, its result on the visible days and its code.
Score each from 0 to 10: if it is refined a little more, how short will journeys be on days nobody has seen yet? Be strict and use the whole range.
Answer with exactly one line per prototype, "<n>: <score> - <reason in at most 20 words>", for all ${protos.length}.

${protos.map((p, i) => `PROTOTYPE ${i + 1}\nApproach:\n${p.idea}\n\n${resultLine(p.result)}\n\n\`\`\`js\n${p.code || '// (no working code)\n'}\`\`\``).join('\n\n')}`;
}

function refinePrompt(c, idea, current, result) {
  return `${task(c)}

${idea ? `This is the prototype your group chose. Its approach:\n${idea}\n\n` : ''}Current version, with its result:

\`\`\`js
${current || '// (no working code yet)\n'}\`\`\`

${resultLine(result)}

Refine it: make journeys shorter, also on days that are not among the visible ones; do not overfit them.
${FILE_RULE}`;
}

function alonePrompt(c, current, result) {
  return `${task(c)}

You work alone on this.
${current ? `Your current version, with its result:\n\n\`\`\`js\n${current}\`\`\`\n\n${resultLine(result)}\n\nImprove it: make journeys shorter.` : 'Write your first version.'}
${FILE_RULE}`;
}

function planPrompt(c, n) {
  return `${task(c)}

You lead ${n} workers. Split the job of writing controller.js into at most ${n} parts that can be written separately (functions with a clear contract between them), one per worker.
Write the interface every part must keep, then one line per part: "PART <n>: <what this worker writes, its function name, inputs and output>". You will put the parts together yourself.`;
}

function partPrompt(c, plan, k, part) {
  return `${task(c)}

A lead split the job into parts. Its plan:
${plan}

You write PART ${k}: ${part}
Write only your part (its functions), keeping to the plan's interface. End your reply with your code in one \`\`\`js block.`;
}

function integratePrompt(c, plan, parts, current, result) {
  return `${task(c)}

You lead the workers. Your plan:
${plan}

${current ? `The current controller.js, with its result:\n\n\`\`\`js\n${current}\`\`\`\n\n${resultLine(result)}\n\nThe workers sent these changes:` : 'The workers sent their parts:'}

${parts.map(p => `PART ${p.k}${p.fix ? ` (asked: ${p.fix})` : ''}:\n\`\`\`js\n${p.code || '// (the worker sent no code)\n'}\`\`\``).join('\n\n')}

Put it all together into one working controller.js.
${FILE_RULE}`;
}

function fixesPrompt(c, plan, nParts, current, result, max) {
  return `${task(c)}

You lead the workers. Your plan:
${plan}

The current controller.js, with its result:

\`\`\`js
${current || '// (no working code yet)\n'}\`\`\`

${resultLine(result)}

Decide what each worker should change next to make journeys shorter. At most ${max} lines, one per part: "FIX <part n>: <the change>". Parts go from 1 to ${nParts}.`;
}

function fixPrompt(c, plan, k, part, fix, current) {
  return `${task(c)}

A lead split the job into parts. Its plan:
${plan}

You wrote PART ${k}: ${part}
The current controller.js:

\`\`\`js
${current || '// (no working code yet)\n'}\`\`\`

The lead asks you: ${fix}
Send the new code of your part only. End your reply with it in one \`\`\`js block.`;
}

function familiesPrompt(c, ideas) {
  return `Below are ${ideas.length} ideas for an elevator controller (${c.goal.split('\n')[0]}).
Group them into families by mechanism: two ideas are in the same family if the controller would decide in essentially the same way, whatever the wording.
Every idea goes in exactly one family. Answer with one line per family: "FAMILY: <idea numbers, comma-separated> | <name in a few words>".

${ideas.map((t, i) => `IDEA ${i + 1}:\n${t}`).join('\n\n')}`;
}

// ---- Running code ----

async function evaluate(c, dir, code, days, as) {
  const at = path.join(dir, 'eval', as);
  const cache = path.join(dir, 'eval', `${as}.json`);
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  fs.rmSync(at, { recursive: true, force: true });
  fs.mkdirSync(at, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'elevator.js'), path.join(at, 'elevator.js'));
  fs.writeFileSync(path.join(at, 'controller.js'), code || 'module.exports = { step() { return null; } };\n');
  fs.writeFileSync(path.join(at, 'days.json'), JSON.stringify(days));
  const r = await sandboxed(c, at, ['node', 'elevator.js', 'controller.js', 'days.json']);
  let v;
  try { v = JSON.parse((r.out.match(/^RESULT (.*)$/m) || [])[1]); }
  catch { v = { gain: -100, days: [], error: r.out.slice(-500) }; }
  if (!code) v.no_code = true;
  fs.rmSync(at, { recursive: true, force: true });
  fs.writeFileSync(cache, JSON.stringify(v));
  return v;
}

// ---- One run ----

function makeRun(c, root, runName, agentOf) {
  const dir = path.join(root, runName);
  fs.mkdirSync(path.join(dir, 'steps'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'versions'), { recursive: true });
  const calls = [];
  // Every reply is kept; asking again for the same step reads it back.
  const ask = async (step, id, prompt) => {
    const a = agentOf(id);
    const file = path.join(dir, 'steps', `${step}.reply.md`);
    let text;
    if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8');
    else {
      const desk = path.join(dir, 'desk', step);
      fs.mkdirSync(desk, { recursive: true });
      text = await run(dir, step, a, prompt, desk);
      fs.writeFileSync(file, text);
    }
    calls.push({ step, agent: a.id, vendor: a.base, judge: step.startsWith('6-families'), chars_in: prompt.length, chars_out: text.length });
    return text;
  };
  const version = async (name, code, inst) => {
    if (code) fs.writeFileSync(path.join(dir, 'versions', `${name}.js`), code);
    return { name, code, result: await evaluate(c, dir, code, inst.visible, `${name}.visible`) };
  };
  const best = vs => vs.reduce((a, v) => (v.result.gain > a.result.gain ? v : a), vs[0]);
  const hidden = (v, inst) => evaluate(c, dir, v.code, inst.hidden, `${v.name}.hidden`);
  return { dir, calls, ask, version, best, hidden };
}

const vendorOf = (agentOf, id) => agentOf(id).base;

// The partner for an idea's author: the next agent in the run's order with another vendor (or any other agent).
function partnerOf(order, author, agentOf) {
  const i = order.indexOf(author);
  const after = [...order.slice(i + 1), ...order.slice(0, i)];
  return after.find(id => vendorOf(agentOf, id) !== vendorOf(agentOf, author)) || after[0] || author;
}

async function runDiamond(c, R, arm, inst, r, agentOf, judges) {
  const order = rotate(arm.agents, r);
  // 1. Diverge: every agent alone.
  const proposals = await pool(order, c.parallel, (id, i) => R.ask(`1-ideas-${String(i + 1).padStart(2, '0')}`, id, divergePrompt(c)));
  const ideas = proposals.flatMap((text, i) => parseIdeas(text, c.ideas_per_agent).map(t => ({ author: order[i], text: t })))
    .map((x, k) => ({ ...x, id: k + 1 }));

  // 2. Everyone scores every idea, shuffled differently for each reader.
  const votes1 = [];
  await pool(order, c.parallel, async (id, i) => {
    const shown = shuffled(ideas, `${R.dir}|c1|${id}`);
    const s = parseScores(await R.ask(`2-scores-${String(i + 1).padStart(2, '0')}`, id, critiquePrompt(c, shown.map(x => x.text))), shown.length);
    shown.forEach((x, k) => { if (k + 1 in s) votes1.push({ voter: id, idea: x.id, score: s[k + 1], own: x.author === id, same_vendor: vendorOf(agentOf, x.author) === vendorOf(agentOf, id) }); });
  });

  // 3. The script keeps the best by the others' votes (own votes do not count); ties at random.
  const score1 = x => mean(votes1.filter(v => v.idea === x.id && !v.own).map(v => v.score)) ?? -1;
  const tie = Object.fromEntries(shuffled(ideas.map(x => x.id), `${R.dir}|tie`).map((id, k) => [id, k]));
  const kept = ideas.slice().sort((a, b) => score1(b) - score1(a) || tie[a.id] - tie[b.id]).slice(0, c.shortlist);

  // 4. Each kept idea is built by its author and a partner, taking turns. All
  // prototypes go round by round, so with "share" a builder can be shown where
  // the other prototypes are: "scores" (their approach and visible result) or
  // "drafts" (also their whole code). The default, "none", shows nothing.
  const protos = kept.map((x, k) => ({ k: k + 1, idea: x, partner: partnerOf(order, x.author, agentOf), versions: [], cur: null, best: null, hidden: null }));
  for (let i = 0; i < c.build_rounds; i++) {
    const others = p => protos.filter(q => q !== p && q.cur).map(q => ({ idea: q.idea.text, result: q.cur.result, code: q.cur.code }));
    await pool(protos, c.parallel, async p => {
      const who = i % 2 ? p.partner : p.idea.author;
      const shown = arm.share && arm.share !== 'none' && i > 0 ? { mode: arm.share, list: others(p) } : null;
      const text = await R.ask(`3-build-p${p.k}-r${i + 1}`, who, buildPrompt(c, p.idea.text, p.cur?.code, p.cur?.result, i + 1, shown));
      p.versions.push(await R.version(`p${p.k}-v${i + 1}`, codeOf(text) || p.cur?.code || null, inst));
    });
    // Everyone moves on together: what the next round sees is this round's best so far.
    for (const p of protos) { const coded = p.versions.filter(w => w.code); p.cur = coded.length ? R.best(coded) : p.cur; }
  }
  for (const p of protos) p.best = R.best(p.versions);

  // 5. Everyone scores the prototypes.
  const votes2 = [];
  await pool(order, c.parallel, async (id, i) => {
    const shown = shuffled(protos, `${R.dir}|c2|${id}`);
    const s = parseScores(await R.ask(`4-scores-${String(i + 1).padStart(2, '0')}`, id, prototypesPrompt(c, shown.map(p => ({ idea: p.idea.text, result: p.best.result, code: p.best.code })))), shown.length);
    shown.forEach((p, k) => { if (k + 1 in s) votes2.push({ voter: id, proto: p.k, idea: p.idea.id, score: s[k + 1], own: p.idea.author === id || p.partner === id, same_vendor: vendorOf(agentOf, p.idea.author) === vendorOf(agentOf, id) }); });
  });
  const score2 = p => mean(votes2.filter(v => v.proto === p.k && !v.own).map(v => v.score)) ?? -1;
  const winner = protos.slice().sort((a, b) => score2(b) - score2(a) || b.best.result.gain - a.best.result.gain)[0];

  // 6. The winner is refined by its builders, taking turns.
  const versions = [winner.best];
  for (let i = 0; i < c.refine_rounds; i++) {
    const who = i % 2 ? winner.partner : winner.idea.author;
    const cur = R.best(versions);
    const text = await R.ask(`5-refine-r${i + 1}`, who, refinePrompt(c, winner.idea.text, cur.code, cur.result));
    versions.push(await R.version(`final-v${i + 1}`, codeOf(text) || cur.code, inst));
  }
  const final = R.best(versions);

  // Hidden days: the final controller and every prototype as it was voted on.
  const finalHidden = await R.hidden(final, inst);
  for (const p of protos) p.hidden = await R.hidden(p.best, inst);
  const bestProto = protos.reduce((a, p) => (p.hidden.gain > a.hidden.gain ? p : a), protos[0]);
  // The counterfactual with no second vote: keep the prototype best on the visible days.
  const byVisible = protos.reduce((a, p) => (p.best.result.gain > a.best.result.gain ? p : a), protos[0]);

  // Families of ideas, by outside judges who never see who wrote what.
  const families = [];
  const forJudges = shuffled(ideas, `${R.dir}|families`);
  for (const j of judges) {
    try {
      const groups = parseFamilies(await R.ask(`6-families-${j.id.replace(/[^\w-]/g, '_')}`, j.id, familiesPrompt(c, forJudges.map(x => x.text))), forJudges.length);
      const covered = new Set(groups.flatMap(g => g.ids));
      families.push({ judge: j.id, families: groups.length + (forJudges.length - covered.size), groups: groups.map(g => ({ ...g, ids: g.ids.map(k => forJudges[k - 1].id) })) });
    } catch (e) { families.push({ judge: j.id, error: String(e.message).split('\n')[0] }); }
  }
  const sameMinusOther = vs => {
    const others = vs.filter(v => !v.own);
    const s = mean(others.filter(v => v.same_vendor).map(v => v.score)), o = mean(others.filter(v => !v.same_vendor).map(v => v.score));
    return s === null || o === null ? null : round2(s - o);
  };
  return {
    final_visible: final.result.gain, final_hidden: finalHidden.gain, final_version: final.name,
    ideas: ideas.map(x => ({ id: x.id, author: x.author, vendor: vendorOf(agentOf, x.author), score: round2(score1(x)), kept: kept.includes(x), text: x.text })),
    prototypes: protos.map(p => ({ k: p.k, idea: p.idea.id, author: p.idea.author, partner: p.partner, visible: p.best.result.gain, hidden: p.hidden.gain, score: round2(score2(p)), versions: p.versions.map(v => ({ name: v.name, visible: v.result.gain, code: !!v.code })) })),
    winner: winner.k, best_hidden: bestProto.k, chose_best: winner.k === bestProto.k,
    gap_to_best: round2(bestProto.hidden.gain - winner.hidden.gain),
    best_visible_would_pick: byVisible.k, pick_by_visible_hidden: byVisible.hidden.gain, gap_if_picked_by_visible: round2(bestProto.hidden.gain - byVisible.hidden.gain),
    share: arm.share || 'none',
    similarity_first: round2(meanPairwise(protos.map(p => p.versions[0]?.code))), similarity_final: round2(meanPairwise(protos.map(p => p.best.code))),
    votes1, votes2, same_vendor_bias_ideas: sameMinusOther(votes1), same_vendor_bias_protos: sameMinusOther(votes2), families,
  };
}

async function runAlone(c, R, arm, inst, r) {
  const order = rotate(arm.agents, r);
  const cands = await pool(order, c.parallel, async (id, i) => {
    const versions = [];
    for (let k = 0; k < c.alone_rounds; k++) {
      const cur = versions.length ? R.best(versions) : null;
      const text = await R.ask(`1-alone-${String(i + 1).padStart(2, '0')}-r${k + 1}`, id, alonePrompt(c, cur?.code, cur?.result));
      versions.push(await R.version(`a${i + 1}-v${k + 1}`, codeOf(text) || cur?.code || null, inst));
    }
    return { i: i + 1, author: id, best: R.best(versions) };
  });
  const pick = cands.reduce((a, x) => (x.best.result.gain > a.best.result.gain ? x : a), cands[0]);
  const versions = [pick.best];
  for (let k = 0; k < c.refine_rounds; k++) {
    const cur = R.best(versions);
    const text = await R.ask(`2-refine-r${k + 1}`, pick.author, refinePrompt(c, null, cur.code, cur.result));
    versions.push(await R.version(`final-v${k + 1}`, codeOf(text) || cur.code, inst));
  }
  const final = R.best(versions);
  const finalHidden = await R.hidden(final, inst);
  for (const x of cands) x.hidden = await R.hidden(x.best, inst);
  const bestCand = cands.reduce((a, x) => (x.hidden.gain > a.hidden.gain ? x : a), cands[0]);
  return {
    final_visible: final.result.gain, final_hidden: finalHidden.gain, final_version: final.name,
    candidates: cands.map(x => ({ i: x.i, author: x.author, visible: x.best.result.gain, hidden: x.hidden.gain })),
    similarity_final: round2(meanPairwise(cands.map(x => x.best.code))),
    picked: pick.i, best_hidden: bestCand.i, chose_best: pick.i === bestCand.i, gap_to_best: round2(bestCand.hidden.gain - pick.hidden.gain),
  };
}

async function runOrchestra(c, R, arm, inst, r) {
  const workers = rotate(arm.agents, r);
  const plan = await R.ask('1-plan', arm.lead, planPrompt(c, workers.length));
  let parts = parseParts(plan, workers.length);
  if (!parts.length) parts = ['the whole controller'];
  const first = await pool(parts, c.parallel, async (part, k) => ({ k: k + 1, code: splitReply(await R.ask(`2-part-${k + 1}`, workers[k], partPrompt(c, plan, k + 1, part))).code }));
  const versions = [];
  let text = await R.ask('3-integrate-0', arm.lead, integratePrompt(c, plan, first, null, null));
  versions.push(await R.version('o-v0', codeOf(text), inst));
  const fixes = [];
  for (let cycle = 1; cycle <= c.orchestra_cycles; cycle++) {
    const cur = R.best(versions);
    const asked = parseFixes(await R.ask(`4-fixes-${cycle}`, arm.lead, fixesPrompt(c, plan, parts.length, cur.code, cur.result, c.orchestra_fixers)), parts.length, c.orchestra_fixers);
    fixes.push({ cycle, parts: asked.map(f => f.part) });
    const sent = await pool(asked, c.parallel, async f => ({ k: f.part, fix: f.fix, code: splitReply(await R.ask(`5-fix-${cycle}-part-${f.part}`, workers[f.part - 1], fixPrompt(c, plan, f.part, parts[f.part - 1], f.fix, cur.code))).code }));
    text = await R.ask(`6-integrate-${cycle}`, arm.lead, integratePrompt(c, plan, sent, cur.code, cur.result));
    versions.push(await R.version(`o-v${cycle}`, codeOf(text) || cur.code, inst));
  }
  const final = R.best(versions);
  const finalHidden = await R.hidden(final, inst);
  return { final_visible: final.result.gain, final_hidden: finalHidden.gain, final_version: final.name, parts: parts.length, fixes, versions: versions.map(v => ({ name: v.name, visible: v.result.gain, code: !!v.code })) };
}

// ---- Plan, config, summary ----

// Runs in the order repeat, instance, arm; the arms' order turns with each
// instance and repeat, so no arm is always first (or always last at dawn).
function planFor(c) {
  const arms = Object.keys(c.arms), out = [];
  for (let r = 0; r < c.repeats; r++) {
    c.instances.forEach((inst, i) => {
      for (const arm of rotate(arms, (r * c.instances.length + i) % arms.length)) if (r < (c.arms[arm].repeats ?? c.repeats)) out.push({ name: `${inst.name}-${arm}-r${r + 1}`, inst, arm, r });
    });
  }
  return out;
}

function loadTask(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const c = {
    title: path.basename(file, '.json'), repeats: 2, ideas_per_agent: 2, shortlist: 4, build_rounds: 3, alone_rounds: 4,
    refine_rounds: 3, orchestra_cycles: 4, orchestra_fixers: 6, parallel: 3, judges: DEFAULT_JUDGES, ...raw,
    proof_wrap: Array.isArray(raw.proof_wrap) && raw.proof_wrap.length ? raw.proof_wrap : PROOF_WRAP,
  };
  if (!String(c.goal || '').trim()) throw new Error(`${file}: needs "goal".`);
  if (!Array.isArray(c.instances) || !c.instances.length) throw new Error(`${file}: needs "instances".`);
  for (const inst of c.instances) {
    if (!/^[\w-]+$/.test(String(inst.name))) throw new Error(`${file}: an instance needs a plain "name".`);
    for (const k of ['visible', 'hidden']) if (!Array.isArray(inst[k]) || !inst[k].length) throw new Error(`${file}: instance ${inst.name} needs "${k}" days.`);
    const seen = new Set(inst.visible.map(d => JSON.stringify(d)));
    if (inst.hidden.some(d => seen.has(JSON.stringify(d)))) throw new Error(`${file}: instance ${inst.name} shows a hidden day.`);
  }
  if (!c.arms || !Object.keys(c.arms).length) throw new Error(`${file}: needs "arms".`);
  for (const [name, a] of Object.entries(c.arms)) {
    if (!/^[\w-]+$/.test(name)) throw new Error(`${file}: arm "${name}" needs a plain name.`);
    if (!MODES.includes(a.mode)) throw new Error(`${file}: arm ${name}: "mode" is ${MODES.join(', ')}.`);
    if (!Array.isArray(a.agents) || !a.agents.length) throw new Error(`${file}: arm ${name} needs "agents".`);
    if (a.mode === 'orchestra' && !a.lead) throw new Error(`${file}: arm ${name} needs a "lead".`);
    if (a.share !== undefined && !['none', 'scores', 'drafts'].includes(a.share)) throw new Error(`${file}: arm ${name}: "share" is none, scores or drafts.`);
    if (a.mode === 'diamond' && a.agents.length * c.ideas_per_agent < c.shortlist) throw new Error(`${file}: arm ${name} has fewer ideas than the shortlist.`);
  }
  return c;
}

// Calls one run of each mode makes, with the config's numbers (the budget the arms share).
function callsFor(c, arm) {
  const n = arm.agents.length;
  if (arm.mode === 'diamond') return n + n + c.shortlist * c.build_rounds + n + c.refine_rounds;
  if (arm.mode === 'alone') return n * c.alone_rounds + c.refine_rounds;
  return 1 + n + 1 + c.orchestra_cycles * (1 + c.orchestra_fixers + 1);
}

function summaryMd(c, rows) {
  const fmt = x => x === null || x === undefined ? '–' : (x >= 0 ? '+' : '') + x.toFixed(1);
  const arms = Object.keys(c.arms);
  const lines = [
    `# ${c.title}`, '',
    'Gain = how much shorter the average journey is than the baseline\'s, in %, averaged over the days. Hidden days were never shown to any agent. "Best version" = best on the visible days, the same rule in every arm.', '',
    '## By arm', '',
    '| Arm | Mode | Agents | Calls planned | Runs | Final gain, hidden days (mean) | Runs (hidden) | Chose its best on hidden days | Mean gap to its best | Gap if picked by visible days | Code alike, first / final | Families of ideas (mean of judges) | Same-vendor vote bias, ideas / prototypes |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const name of arms) {
    const a = c.arms[name], rs = rows.filter(x => x.arm === name);
    const fam = mean(rs.flatMap(x => (x.families || []).filter(f => typeof f.families === 'number').map(f => f.families)));
    const b1 = mean(rs.map(x => x.same_vendor_bias_ideas).filter(x => typeof x === 'number'));
    const b2 = mean(rs.map(x => x.same_vendor_bias_protos).filter(x => typeof x === 'number'));
    const sim = k => { const m = mean(rs.map(x => x[k]).filter(x => typeof x === 'number')); return m === null ? '–' : m.toFixed(2); };
    lines.push(`| ${name}${a.share && a.share !== 'none' ? ` (share: ${a.share})` : ''} | ${a.mode} | ${a.mode === 'orchestra' ? `${a.lead} + ` : ''}${a.agents.join(', ')} | ${callsFor(c, a)} | ${rs.length} | ${fmt(mean(rs.map(x => x.final_hidden)))} | ${rs.map(x => fmt(x.final_hidden)).join(', ') || '–'} | ${rs.some(x => 'chose_best' in x) ? `${rs.filter(x => x.chose_best).length} of ${rs.length}` : '–'} | ${fmt(mean(rs.map(x => x.gap_to_best).filter(x => typeof x === 'number')))} | ${fmt(mean(rs.map(x => x.gap_if_picked_by_visible).filter(x => typeof x === 'number')))} | ${a.mode === 'diamond' ? `${sim('similarity_first')} / ${sim('similarity_final')}` : sim('similarity_final')} | ${fam === null ? '–' : fam.toFixed(1)} | ${a.mode === 'diamond' ? `${fmt(b1)} / ${fmt(b2)}` : '–'} |`);
  }
  lines.push('', '## Runs', '', '| Run | Final, visible | Final, hidden | Calls made (players) | By vendor | Characters sent / received | Judge calls |', '|---|---|---|---|---|---|---|');
  for (const x of rows.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    const by = {}, players = x.calls.filter(k => !k.judge);
    for (const k of players) by[k.vendor] = (by[k.vendor] || 0) + 1;
    const chars = f => players.reduce((n, k) => n + k[f], 0);
    lines.push(`| ${x.name} | ${fmt(x.final_visible)} | ${fmt(x.final_hidden)} | ${players.length} | ${Object.entries(by).map(([v, n]) => `${v} ${n}`).join(', ')} | ${chars('chars_in')} / ${chars('chars_out')} | ${x.calls.length - players.length} |`);
  }
  lines.push('', 'Pista until the preregistered rule is met (lab/influence-plan.md, row 16): 3 instances x 2 repeats, effect clear in all 3 instances.', '');
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  if (!file) { console.error('usage: node diamond.js <config.json> [--out=<folder>] [--runs=a,b] [--no-preflight]'); process.exit(2); }
  const c = loadTask(file);
  const pick = (args.find(a => a.startsWith('--runs=')) || '').slice(7).split(',').filter(Boolean);
  const cfg = loadAgents();
  const cache = {};
  const agentOf = id => cache[id] || (cache[id] = resolveAgent(cfg.agents.filter(x => x.type !== 'url'), id));
  const judges = c.judges.map(agentOf);
  const out = (args.find(a => a.startsWith('--out=')) || '').slice(6).replace(/^~(?=\/)/, require('os').homedir());
  const root = out ? path.resolve(out) : path.join(HOME_DIR, 'diamond', `${stamp()}-${crypto.randomBytes(2).toString('hex')}`);
  fs.mkdirSync(root, { recursive: true });
  console.log(`Double diamond: ${root}`);

  // Each base agent says one word first; one that can't sits this run out (its runs wait for next time).
  const down = new Map();
  if (!args.includes('--no-preflight')) {
    const bases = [...new Set(Object.values(c.arms).flatMap(a => [...a.agents, ...(a.lead ? [a.lead] : [])]).map(id => String(id).split('#')[0]))];
    for (const b of bases) {
      try {
        const r = await run(path.join(root, 'preflight'), b.replace(/[^\w-]/g, '_'), agentOf(b), 'Reply with the single word OK.', root);
        if (!/\bOK\b/i.test(r)) throw new Error(`said "${String(r).trim().slice(0, 80)}" instead of OK`);
      } catch (e) { down.set(b, String(e.message).split('\n')[0]); console.error(`  ✗ ${b} is out of this run: ${String(e.message).split('\n')[0]}`); }
    }
  }

  const rows = [];
  const save = () => {
    fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(rows.slice().sort((a, b) => a.name.localeCompare(b.name)), null, 2));
    fs.writeFileSync(path.join(root, 'summary.md'), summaryMd(c, rows));
  };
  let left = 0;
  for (const s of planFor(c).filter(s => !pick.length || pick.includes(s.name))) {
    const done = path.join(root, s.name, 'run.json');
    if (fs.existsSync(done)) { rows.push(JSON.parse(fs.readFileSync(done, 'utf8'))); continue; }
    const arm = c.arms[s.arm];
    const needs = [...arm.agents, ...(arm.lead ? [arm.lead] : [])].map(id => String(id).split('#')[0]);
    if (needs.some(b => down.has(b))) { left++; continue; }
    console.log(`\n${s.name}`);
    const R = makeRun(c, root, s.name, agentOf);
    try {
      const res = arm.mode === 'diamond' ? await runDiamond(c, R, arm, s.inst, s.r, agentOf, judges)
        : arm.mode === 'alone' ? await runAlone(c, R, arm, s.inst, s.r) : await runOrchestra(c, R, arm, s.inst, s.r);
      const row = { name: s.name, instance: s.inst.name, arm: s.arm, mode: arm.mode, repeat: s.r + 1, ...res, calls: R.calls };
      fs.writeFileSync(done, JSON.stringify(row, null, 2));
      rows.push(row);
      console.log(`  → hidden ${res.final_hidden}%, ${R.calls.length} calls`);
    } catch (e) { left++; console.error(`  ✗ ${s.name}: ${String(e.message).split('\n')[0]}`); }
    save();
  }
  save();
  console.log(`\n${path.join(root, 'summary.md')}`);
  // Anything not done: exit 3, so the night queue runs the job again next night.
  if (left) { console.error(`diamond: ${left} run(s) not done; run again with the same --out`); process.exit(3); }
}

module.exports = { plain, similarity, parseIdeas, parseScores, parseParts, parseFixes, parseFamilies, shuffled, partnerOf, planFor, loadTask, callsFor, summaryMd, divergePrompt, critiquePrompt };
if (require.main === module) main().catch(e => { console.error(`diamond: ${e.message}`); process.exit(1); });
