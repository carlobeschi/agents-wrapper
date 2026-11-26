#!/usr/bin/env node
// @ts-check
// The research runner: reproducible, affordable sessions with agents from
// different providers, for comparing ways of working together. See README,
// "Research runner", and runner/*.js.
//
//   node runner.js check <study.json>        check a study file; prints what it would run
//   node runner.js budget <run folder>       money used so far: reported, computed, estimated
//
// Running sessions, resuming, reports and blinded exports come in the next
// changes. Nothing here calls a model yet.

const fs = require('fs');
const path = require('path');
const { checkStudy } = require('./runner/study');
const { Ledger } = require('./runner/budget');

const [cmd, target] = process.argv.slice(2);
const die = (msg) => { console.error(msg); process.exit(1); };

if (cmd === 'check' && target) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (e) { die(`${target}: ${e.message}`); }
  let s;
  try { s = checkStudy(raw); } catch (e) { die(e.message); }
  const sessions = s.cases.length * s.conditions.length * s.repeats;
  console.log(`${s.title}: ${s.cases.length} case(s) x ${s.conditions.length} condition(s) x ${s.repeats} repeat(s) = ${sessions} session(s)`);
  for (const c of s.conditions) {
    const seats = Object.entries(c.seats).map(([r, m]) => `${r}=${[m].flat().join('+')}`).join(', ');
    console.log(`  ${c.id} (${c.pattern}${c.peer_consultation ? ', peer consultation' : ''}): ${seats}`);
  }
  console.log(`Spend cap: $${s.spend.run_usd} for the run${s.spend.session_usd ? `, $${s.spend.session_usd} per session` : ''}.`);
} else if (cmd === 'budget' && target) {
  const file = path.join(target, 'ledger.jsonl');
  if (!fs.existsSync(file)) die(`no ledger.jsonl in ${target}`);
  const t = new Ledger({ file, run_usd: Infinity, readonly: true }).totals();
  console.log(`Used $${t.total_usd.toFixed(4)}: reported $${t.reported_usd.toFixed(4)}, computed from tokens $${t.computed_usd.toFixed(4)}, `
    + `estimated (cost unknown) $${t.estimated_usd.toFixed(4)}${t.held_usd ? `, held by calls still open $${t.held_usd.toFixed(4)}` : ''}.`);
} else {
  die('usage: node runner.js check <study.json> | budget <run folder>');
}
