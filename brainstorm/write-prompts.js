#!/usr/bin/env node
// @ts-check
// Have another agent write the brainstorm's instructions, on its own:
// `node brainstorm/write-prompts.js <agent id>` (an agent of brainstorm/agents.json).
//
// The built-in prompts were written by Claude, and Claude kept winning, so the
// app lets another agent write a whole set to compare. The agent gets the
// purpose of each step, the facts it can use ({placeholders}) and what the app
// adds by itself (the reply format), but never the built-in text. It runs with
// its read-only command, in an empty folder. The set is saved as
// ~/.agent-dispatch/brainstorm-instructions/<agent>.json (BRAINSTORM_INSTRUCTIONS
// for another folder), and the app offers it under "Instructions written by".

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadAgents, commandFor, checkInstructions, STEPS, NEEDED, INSTR_DIR } = require('./engine');
const { agentEnv } = require('../config');

const PURPOSE = {
  research: 'Before any idea, each agent researches the problem alone and brings back a few findings with their sources and one surprise, to give the group a richer starting point. It cannot change anything.',
  ideas: 'Each agent, alone, proposes a fixed number of distinct ideas for the problem. Afterwards every agent scores every other agent\'s ideas without knowing who proposed them, and the best few are developed by every agent. An idea must be something one agent can develop in one session by working on files in a folder, with no network.',
  vote: 'Each agent scores the other agents\' ideas (never its own), shown without names and in a random order, from 1 to 10, with a reason for each score; on the given criteria if there are any. The ideas with the best average go forward.',
  build: 'Each agent, alone, develops all the winning ideas in its own folder (its own git branch), leaves a short BRAINSTORM.md saying what it made and where, and reports what it built. Other agents develop the same ideas on their own.',
};
const FACTS = {
  problem: 'the problem, as the person wrote it',
  agents: 'how many agents take part',
  context: 'what material is in the current folder (a copy of a repository or folder, or none)',
  web: 'whether this agent can search and read the web (yes/no, with a few words)',
  sharing: 'who will read the findings (everyone, without names, or only this agent)',
  notes: 'the research notes this agent may see (everyone\'s without names, or its own, or "none")',
  ideas_per_agent: 'how many ideas to propose',
  top: 'how many ideas go forward',
  ideas: 'the numbered list of ideas to score, I1, I2, …',
  count: 'how many ideas are in that list',
  criteria: 'the voting criteria, numbered C1, C2, …, or a line saying there are none',
  winners: 'the numbered list of winning ideas to develop',
  folder: 'what the current folder is (a git branch only for this agent, with or without a copy of the material)',
  can_run: 'whether this agent can run commands in its folder (yes/no)',
};

function brief() {
  return [
    'You are writing the instructions (prompts) for a small app in which several AI agents, possibly from different AI labs, brainstorm a problem a person gives them. Each step below sends one prompt to every agent; the agents work alone and never see each other\'s names. Write the prompt for each step, as well as you can, in English. They will be used for any problem, from a children\'s game to a business question.',
    '',
    'The steps, and what each is for:',
    ...Object.entries(PURPOSE).map(([k, v]) => `- ${k}: ${v}`),
    '',
    'In a prompt, write {name} where the app should put one of these facts (only the ones listed for that step):',
    ...Object.entries(STEPS).map(([k, vars]) => `- ${k}: ${vars.map(v => `{${v}} (${FACTS[v]})`).join('; ')}. Must use: ${NEEDED[k].map(v => `{${v}}`).join(', ')}.`),
    '',
    'Below each prompt the app adds, by itself, the exact reply format it needs (for example "IDEA: … WHAT: … WHY: …" for ideas, "I1: 7 - why" for the vote, "FINDING: … SOURCE: …" for research, "WHAT I BUILT: …" for build), so do not describe a reply format of your own.',
    '',
    'Reply with only a JSON object, in a ```json block, with exactly these string fields: "research", "ideas", "vote", "build".',
  ].join('\n');
}

function extract(text) {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(text) || /(\{[\s\S]*\})/.exec(text);
  if (!m) throw new Error('no JSON in the reply');
  return JSON.parse(m[1]);
}

function main() {
  const id = process.argv[2];
  const agent = loadAgents().find(a => a.id === id);
  if (!agent) { console.error(`usage: node brainstorm/write-prompts.js <agent id> (one of: ${loadAgents().map(a => a.id).join(', ')})`); process.exit(2); }
  if (id === 'claude') { console.error('Claude\'s set is the built-in one.'); process.exit(2); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainstorm-write-'));
  const prompt = brief();
  let last = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    console.log(`Asking ${agent.label} to write the instructions${attempt > 1 ? ' (again)' : ''}…`);
    const cmd = commandFor(agent, 'read');
    const viaArg = cmd.some(s => s.includes('{prompt}'));
    const [bin, ...args] = cmd.map(s => s.split('{prompt}').join(prompt));
    const r = spawnSync(bin, args, { cwd: dir, env: agentEnv(agent.env), input: viaArg ? undefined : prompt, encoding: 'utf8', timeout: 15 * 60000, maxBuffer: 16 * 1024 * 1024 });
    last = (r.stdout || '') + (r.stderr ? `\n${r.stderr.slice(-2000)}` : '');
    try {
      const raw = extract(r.stdout || '');
      const set = checkInstructions({ research: raw.research, ideas: raw.ideas, vote: raw.vote, build: raw.build });
      const out = { author: agent.label, model: agent.model || null, written: new Date().toISOString(), brief: prompt, ...set };
      fs.mkdirSync(INSTR_DIR(), { recursive: true });
      const file = path.join(INSTR_DIR(), `${id}.json`);
      fs.writeFileSync(file, JSON.stringify(out, null, 2));
      console.log(`Saved ${file}. Restart the app and pick "${agent.label}" under "Instructions written by".`);
      return;
    } catch (e) { console.warn(`  not usable: ${e.message}`); }
  }
  console.error(`${agent.label} did not write a usable set. Its last reply:\n${last.slice(-3000)}`);
  process.exit(1);
}

module.exports = { brief, extract };
if (require.main === module) main();
