#!/usr/bin/env node
// Writes examples/bench/bench-v1.json: the collaboration bench, version 1.
// `node scripts/make-bench-v1.js`. The puzzle banks are generated from a fixed
// seed, so the file is the same every time; a new version gets a new seed.
// What each row and column is, and why: see the header of bench.js.

const fs = require('fs');
const path = require('path');
const { generate } = require('../puzzles');

let seed = 20261110;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

const SVG = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">', '</svg>'];
const NO_TEXT = { say: 'No text in the drawing.', type: 'every', pattern: '^(?!.*<text)' };
const drawing = (scene, answers) => ({
  kind: 'svg', start: SVG, checks: [NO_TEXT], guess: { agent: 'claude', answers },
  brief: `Draw this scene on this 400 by 400 canvas: ${scene}. Use simple shapes (no text, letters or digits anywhere). Someone who knows nothing will be shown the picture and asked what it shows.`,
});
const COLOURS = 'red|blue|green|gold|grey|white|black|silver|amber';
const poem = (subject, word, banned) => ({
  kind: 'poem',
  brief: `A twelve-line poem about ${subject}. Make it good enough to read aloud.`,
  checks: [
    { say: 'The poem is exactly 12 lines.', type: 'lines', min: 12, max: 12 },
    { say: 'Every line has exactly 8 words (a word is anything between spaces).', type: 'every', pattern: '^\\s*\\S+(\\s+\\S+){7}\\s*$' },
    { say: `The first letters of the lines spell ${word}, in order.`, type: 'acrostic', word },
    { say: `Every line names a colour: ${COLOURS.split('|').join(', ').replace(/, (\w+)$/, ' or $1')}.`, type: 'every', pattern: `\\b(${COLOURS})\\b` },
    { say: 'The letter "u" never appears.', type: 'every', pattern: '^[^u]*$' },
    { say: `The word "${banned}" never appears.`, type: 'every', pattern: `^(?!.*\\b${banned}\\b)` },
    { say: 'The last line ends with a question mark.', type: 'last', pattern: '\\?\\s*$' },
  ],
});
const bank = () => Array.from({ length: 24 }, () => generate(6, rnd));

const C = (...xs) => xs; // readability
const bench = {
  title: 'Collaboration bench v1',
  version: 1,
  judges: ['claude', 'codex', 'antigravity'],
  process_judges: ['claude', 'codex'],
  team: ['claude#1', 'claude#2'],
  solo: 'claude',
  repeats: 3,
  ping: true, // one short call to each model before a run: a model that doesn't answer stops it (bench.js)
  room: { silent: true, turns: true, moves: 8, min_moves: 3, lines_per_move: 4, max_minutes: 8, words: 30, self_review: true },
  rows: [
    { id: 'solo', label: 'Claude alone', solo: true, wrongnote: { solo: ['claude'] } },
    { id: 'best-of-4', label: 'Best of 4 alone', skip: ['puzzle', 'wrongnote'], variant: { tournament: { generate: C('claude#1', 'claude#2', 'claude#3', 'claude#4'), revise: false, rank: 'claude' }, not_judged_by: ['claude'] } },
    { id: 'pair-silent', label: 'Pair, silent, turns', variant: { room: { silent: true, turns: true } } },
    { id: 'pair-talk', label: 'Pair, talking, turns', variant: { room: { silent: false, turns: true } }, wrongnote: { pairs: [['claude#1', 'claude#2']] } },
    { id: 'pair-versions', label: 'Pair with versions', variant: { room: { silent: false, turns: true, versions: true } } },
    { id: 'pair-plan', label: 'Pair, plan first', variant: { room: { silent: false, turns: true, plan_first: true } } },
    { id: 'trio-talk', label: 'Trio, talking', variant: { agents: C('claude#1', 'claude#2', 'claude#3'), room: { silent: false, turns: true } } },
    { id: 'mixed-pair', label: 'Claude + Gemini, versions', variant: { agents: C('claude', 'antigravity'), room: { silent: false, turns: true, versions: true } }, wrongnote: { pairs: [['claude', 'antigravity'], ['antigravity', 'claude']] } },
    { id: 'tournament', label: 'Tournament, Claude only', skip: ['puzzle', 'wrongnote'], variant: { tournament: { generate: C('claude#1', 'claude#2'), review: 'claude', rank: 'claude' }, not_judged_by: ['claude'] } },
    { id: 'tournament-mixed', label: 'Tournament, Gemini reviews, Codex picks', skip: ['puzzle', 'wrongnote'], variant: { tournament: { generate: C('claude#1', 'claude#2'), review: 'antigravity', rank: 'codex' }, not_judged_by: ['antigravity', 'codex'] } },
  ],
  tasks: [
    { id: 'drawing', instances: [
      drawing('a lighthouse keeper’s cat watching a storm from the window', [['cat'], ['lighthouse'], ['storm', 'rain', 'lightning', 'waves']]),
      drawing('a fox reading a map by lantern light in a snowy forest', [['fox'], ['map'], ['lantern', 'lamp', 'light']]),
      drawing('a heron catching a fish at dawn beside a broken wooden bridge', [['heron', 'crane', 'stork', 'bird'], ['fish'], ['bridge']]),
    ] },
    { id: 'poem', instances: [
      poem('two people repairing an old rowing boat together', 'TOGETHERNESS', 'boat'),
      poem('two strangers sharing one umbrella in the rain', 'FRIENDLINESS', 'rain'),
      poem('the night shift at a small bakery', 'CONVERSATION', 'bread'),
    ] },
    { id: 'puzzle', judge: false, room: { silent: false, turns: false, moves: 6, min_moves: 0, max_minutes: 8, self_review: false },
      instances: [{ bank: bank() }, { bank: bank() }, { bank: bank() }] },
    { id: 'wrongnote', wrongnote: ['examples/pair/wrong-note/wrong-note.json', 'examples/pair/wrong-note-units/study-7b-units.json'] },
  ],
  // Cells written by other runners in the same shape (swarm.js): folders, relative to the run folder.
  external: ['cells'],
};

const out = path.join(__dirname, '..', 'examples', 'bench', 'bench-v1.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(bench, null, 1) + '\n');
console.log(out);
