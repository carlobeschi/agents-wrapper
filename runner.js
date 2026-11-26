#!/usr/bin/env node
// @ts-check
// The research runner: reproducible, affordable sessions with agents from
// different providers, for comparing ways of working together. See README,
// "Research runner", and runner/*.js.
//
//   node runner.js check <study.json>                 check a study file; prints what it would run
//   node runner.js run <study.json> [--out <folder>]  run every session; the same command resumes
//        [--run-usd N]       raise the run's spend cap for this run (the study file stays as it was)
//        [--retry-errors]    on resume, run again the sessions that failed on a provider error
//   node runner.js budget <run folder>                money used so far: reported, computed, estimated
//
// Models are "provider:model": anthropic, openai, google, openrouter, or fake
// (tests and dry runs). Keys come from the environment only: ANTHROPIC_API_KEY,
// OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY (README, Research runner).
// Run folders default to ~/.agent-dispatch/runner/<date>-<title words>/.

const fs = require('fs');
const path = require('path');
const { checkStudy } = require('./runner/study');
const { Ledger } = require('./runner/budget');
const { runStudy } = require('./runner/run');
const { fakeProvider, defaultFakeStep } = require('./runner/providers');
const { realAdapters, missingKeys } = require('./runner/adapters');
const { providerOf } = require('./runner/study');
const { HOME_DIR, stamp } = require('./config');

const args = process.argv.slice(2);
const [cmd, target] = args;
const opt = (name) => { const i = args.indexOf(name); return i > 0 ? args[i + 1] : undefined; };
const die = (msg) => { console.error(msg); process.exit(1); };

function readStudy(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { die(`${file}: ${e.message}`); }
  try { return { raw, s: checkStudy(raw) }; } catch (e) { return die(e.message); }
}

if (cmd === 'check' && target) {
  const { s } = readStudy(target);
  const sessions = s.cases.length * s.conditions.length * s.repeats;
  console.log(`${s.title}: ${s.cases.length} case(s) x ${s.conditions.length} condition(s) x ${s.repeats} repeat(s) = ${sessions} session(s)`);
  for (const c of s.conditions) {
    const seats = Object.entries(c.seats).map(([r, m]) => `${r}=${[m].flat().join('+')}`).join(', ');
    console.log(`  ${c.id} (${c.pattern}${c.peer_consultation ? ', peer consultation' : ''}): ${seats}`);
  }
  console.log(`Spend cap: $${s.spend.run_usd} for the run${s.spend.session_usd ? `, $${s.spend.session_usd} per session` : ''}.`);
} else if (cmd === 'run' && target) {
  const { raw, s } = readStudy(target);
  const words = s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').split('-').filter(Boolean).slice(0, 4).join('-');
  const out = opt('--out') || path.join(HOME_DIR, 'runner', `${stamp()}-${words}`);
  const runUsd = opt('--run-usd') !== undefined ? Number(opt('--run-usd')) : undefined;
  if (runUsd !== undefined && !(runUsd > 0)) die('--run-usd: a number more than 0');
  const needed = [...new Set(s.conditions.flatMap(c => Object.values(c.seats).flat().map(providerOf)))];
  const noKey = missingKeys(needed);
  if (noKey.length) die(`Not set: ${noKey.join(', ')}. Export them in this shell first (on the Mac, from the Keychain); they are never read from a file.`);
  let adapters;
  try { adapters = { ...realAdapters(), fake: fakeProvider(defaultFakeStep).adapter }; } catch (e) { die(e.message); }
  console.log(`Run folder: ${out}`);
  runStudy({ study: raw, out, adapters, retry_errors: args.includes('--retry-errors'),
    run_usd: runUsd, say: (line) => console.log(line) })
    .catch(e => die(e.message));
} else if (cmd === 'budget' && target) {
  const file = path.join(target, 'ledger.jsonl');
  if (!fs.existsSync(file)) die(`no ledger.jsonl in ${target}`);
  const t = new Ledger({ file, run_usd: Infinity, readonly: true }).totals();
  console.log(`Used $${t.total_usd.toFixed(4)}: reported $${t.reported_usd.toFixed(4)}, computed from tokens $${t.computed_usd.toFixed(4)}, `
    + `estimated (cost unknown) $${t.estimated_usd.toFixed(4)}${t.held_usd ? `, held by calls still open $${t.held_usd.toFixed(4)}` : ''}.`);
} else {
  die('usage: node runner.js check <study.json> | run <study.json> [--out <folder>] [--run-usd N] [--retry-errors] | budget <run folder>');
}
