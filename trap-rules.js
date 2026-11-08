#!/usr/bin/env node
// Ask an agent to word The Trap's rules: `node trap-rules.js <agent-id> <out.json>`.
//
// The Trap's prompts were written by Claude, who also directs the show, so the
// wording may suit the way Claude reasons. This asks another agent (Antigravity
// by default) to write every instruction of the same game from a plain
// description of how it works. The description is not Claude's prompt text, so
// the author doesn't start from it. The app checks the reply (checkPrompts in
// trap.js) and, if something it needs is missing, asks once more with the
// problems listed. The result is a prompts file for trap.js ("prompts" in a
// trap config); the full exchange is kept in a run folder under
// ~/.agent-dispatch/trap-rules/.

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { HOME_DIR, loadConfig, stamp } = require('./config');
const { UNATTENDED } = require('./talk');
const { run } = require('./motion');
const { checkPrompts, PROMPT_KEYS } = require('./trap');

const SPEC = `## How the game works

The Trap is a weekly game between two or three AI agents from different labs. An app runs it; no person and no agent referees.

1. Setting. Each agent, alone, writes one puzzle for the others, with its answer and a private note on where it expects the others to go wrong. No agent sees another's puzzle while setting. The agents have no tools, files or web access: the puzzle must be solvable by reasoning alone, in text. The app compares answers as text (forgiving case, spacing, quotes, a trailing full stop and number formatting, nothing cleverer), so an answer has to be short: a number, a word or a short sequence.
2. Rereading. The setter is shown its own puzzle, answer and note once more and may fix them.
3. Blind check. A fresh copy of the setter, which has never seen the answer, solves the puzzle. If its answer doesn't match, the puzzle is void.
4. Solving. Each other agent gets one attempt. Before working, it states privately how sure it is, from 0 to 100, that it will get it right. Then it shows brief working and its final answer.
5. Scoring, by the app. For each solver: a right answer is a point to the solver; a wrong answer is a point to the setter; on a void puzzle the solver gets the point whatever it answered.
6. After. When all puzzles are done, each agent is shown every puzzle, answer, ruling and the score, plus its own private note, and writes alone, briefly, what it got wrong and what the game showed.

Everything private (the notes, the confidence, the after notes) is published with the episode, after the game, and the agents may be told so. No agent sees another's private pieces during the game.`;

const FORMAT = `## What you write

The app sends one instruction text at each step. Write those texts. Word them as you think best: you decide how to explain the game, the incentives and the puzzle rules. Only the reply formats below are fixed, because the app reads replies by them.

Reply with one JSON object, in a \`\`\`json fenced block, with these string fields:

- "rules": the rules a puzzle must meet. Used wherever you put {rules}.
- "solve_rules": how to answer: brief working, then the final answer on the last line as "Answer: <answer>". Must contain the text "Answer:". Used wherever you put {solve_rules}.
- "set": the instruction for step 1, to one setter. It must ask for a reply in exactly three parts under the headings "## Puzzle", "## Answer" (the answer alone, on one line) and "## Why they will fail". Use {words} for the puzzle's word limit.
- "review": the instruction for step 2. The app adds, after your text, the setter's puzzle, answer and note under the same three headings. The reply must use the same three headings: "## Puzzle", "## Answer", "## Why they will fail". Use {words} again.
- "self": the instruction for step 3, to the fresh copy. It must not mention a setter or a game: the copy only solves. The app adds the puzzle after your text. It must lead to a last line "Answer: <answer>".
- "solve": the instruction for step 4, to one solver. Its reply must start with a line "Confidence: <0 to 100>%" and end with "Answer: <answer>". Use {setter} for the setter's name. The app adds the puzzle after your text.
- "after": the instruction for step 6. The app adds the puzzles, answers, rulings, score and the agent's own note after your text. Keep the note short.
- "author": your own name, as you'd like it credited.

Placeholders the app fills: {me} (the agent the text is sent to), {others} (the other agents' names, joined), {setter} (in "solve" only), {words} (in "set" and "review"), {published} (a sentence saying the others never see this piece and it is published after the game), {rules}, {solve_rules}. The app adds, after each of your texts, one line saying the agent runs unattended and tools that need permission are refused. Write the texts in English.`;

function authorPrompt(me) {
  return [
    `You are ${me.label}. You are writing the rules, as prompts, for a game that AI agents (including agents like you) will play. Make them clear and fair to every player, so the game is a good test of reasoning and the puzzles are good ones.`,
    '', SPEC, '', FORMAT, '', UNATTENDED(),
  ].join('\n');
}

function parsePrompts(text) {
  const fenced = String(text).match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const raw = fenced ? fenced[1] : String(text).slice(String(text).indexOf('{'), String(text).lastIndexOf('}') + 1);
  try { return JSON.parse(raw); } catch (e) { return { error: `the reply is not valid JSON (${e.message})` }; }
}

async function main() {
  const [id = 'antigravity', out] = process.argv.slice(2);
  if (!out) { console.error('usage: node trap-rules.js <agent-id> <out.json>'); process.exit(2); }
  const c = loadConfig().agents.find(a => a.id === id && a.type !== 'url' && a.headless);
  if (!c) throw new Error(`${id} is not a headless agent in agents.json.`);
  const dir = path.join(HOME_DIR, 'trap-rules', `${stamp()}-${crypto.randomBytes(2).toString('hex')}`);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const me = { ...c, label: c.label || id };
  console.log(`Trap rules by ${me.label}\nRun folder: ${dir}`);
  let prompt = authorPrompt(me), p, bad = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await run(dir, `rules-${attempt}`, me, prompt, home);
    p = parsePrompts(reply);
    bad = p.error ? [p.error] : checkPrompts(p);
    if (!bad.length) break;
    console.warn(`  ✗ attempt ${attempt}: ${bad.join('; ')}`);
    prompt = [authorPrompt(me), '', '## Your last reply', '', reply, '', '## What the app could not use',
      '', ...bad.map(b => `- ${b}`), '', 'Reply again with the whole JSON object, fixed.'].join('\n');
  }
  if (bad.length) throw new Error(`no usable rules from ${me.label}: ${bad.join('; ')}`);
  const clean = Object.fromEntries(['author', ...Object.keys(PROMPT_KEYS)].map(k => [k, p[k]]));
  clean.author = String(clean.author || me.label);
  clean.written_by = { agent: id, model: me.model || '(CLI default)', run: path.basename(dir) };
  fs.writeFileSync(out, JSON.stringify(clean, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'prompts.json'), JSON.stringify(clean, null, 2) + '\n');
  console.log(`Rules: ${out}`);
}

if (require.main === module) main().catch(e => { console.error(`trap-rules: ${e.message}`); process.exit(1); });

module.exports = { authorPrompt, parsePrompts };
