// @ts-check
// The run report (report.md in the run folder): what ran, with which models,
// what came out of each session, where the evidence is, and what it cost.
// It counts; it does not say which condition is better. With few sessions per
// condition it says so in its first lines.

const fs = require('fs');
const path = require('path');
const { Ledger } = require('./budget');
const { EventLog } = require('./events');

/** @param {string} run */
function writeReport(run) {
  const study = JSON.parse(fs.readFileSync(path.join(run, 'study.json'), 'utf8'));
  const state = JSON.parse(fs.readFileSync(path.join(run, 'state.json'), 'utf8'));
  const ledger = new Ledger({ file: path.join(run, 'ledger.jsonl'), run_usd: study.spend.run_usd, readonly: true });
  const events = new EventLog(run).all();
  const t = ledger.totals();
  const $ = (x) => `$${x.toFixed(4)}`;
  const sessions = Object.entries(state.sessions);
  const perCondition = {};
  for (const [, s] of sessions) {
    const o = s.outcome && JSON.parse(fs.readFileSync(path.join(run, s.outcome.path, 'outcome.json'), 'utf8'));
    const c = o ? o.condition : '?';
    const cell = (perCondition[c] ||= { n: 0, complete: 0, ended_early: 0, incomplete: 0, none: 0 });
    cell.n++;
    if (!s.outcome) cell.none++; else cell[s.outcome.status]++;
  }
  const maxN = Math.max(...Object.values(perCondition).map(c => c.n));
  const replies = events.filter(e => e.kind === 'reply');
  const returned = [...new Set(replies.map(e => `${e.model} -> ${e.model_returned}`))];
  const lines = [
    `# ${study.title}`,
    '',
    `Run folder: ${path.basename(run)}. Study file sha256 ${state.study_sha256.slice(0, 16)}. Started ${state.created}.`,
    '',
    `**This report counts what happened; it does not show that any condition works better.** At most ${maxN} session(s) per condition${maxN < 10 ? ': far too few to compare effectiveness' : ''}. Scores, if any, come from the blinded export and its ratings, not from here.`,
    '',
    '## Configuration',
    '',
    `- Cases: ${study.cases.map(c => `${c.id} (final answer starts "${c.final_answer.marker}")`).join('; ')}`,
    `- Conditions: ${study.conditions.map(c => `${c.id} = ${c.pattern}${c.peer_consultation ? ' + peer consultation' : ''}: ${Object.entries(c.seats).map(([r, m]) => `${r} ${[m].flat().join(' + ')}`).join(', ')}`).join('; ')}`,
    `- Repeats ${study.repeats}; seed ${study.seed ?? 'none'} (sent to providers that take one; not every model honours it)`,
    `- Limits: ${study.limits.turns} closing turns, ${study.limits.max_output_tokens} output tokens per call, ${study.limits.timeout_s} s per call, ${study.limits.retries} retries`,
    `- Prompt versions: ${Object.entries(study.roles).map(([r, x]) => `${r} ${x.prompt_version}`).join(', ')}`,
    `- Prices: ${Object.entries(study.prices || {}).map(([m, p]) => `${m} $${p.in_per_mtok}/$${p.out_per_mtok} per M tokens (as of ${p.as_of})`).join('; ') || 'none (fake models only)'}`,
    `- Models that answered: ${returned.join('; ') || 'none'}`,
    `- Interviews: ${study.conditions.filter(c => c.pattern === 'interview').map(c => `${c.id} at most ${c.max_messages || 12} messages, end token ${c.end_token || '<|CASE_INTERVIEW_END|>'}, hint marker ${c.hint_marker === null ? 'none' : (c.hint_marker || 'HINT:')}${c.last_turn_notice ? ', last-turn notice' : ''}${c.paper_prompts ? ', paper prompts' : ''}`).join('; ') || 'none'}`,
    `- Temperatures: ${Object.entries(study.roles).filter(([, r]) => typeof r.temperature === 'number').map(([n, r]) => `${n} ${r.temperature}`).join(', ') || 'provider defaults'}`,
    '',
    '## Adaptations',
    '',
    ...((study.adaptations || []).length ? study.adaptations.map(a => `- ${a}`) : ['- none listed in the study file']),
    '',
    '## Sessions per condition',
    '',
    '| Condition | Sessions | Complete | Ended early | Incomplete | Not finished |',
    '|---|---|---|---|---|---|',
    ...Object.entries(perCondition).map(([c, x]) => `| ${c} | ${x.n} | ${x.complete} | ${x.ended_early} | ${x.incomplete} | ${x.none} |`),
    '',
    '## Every session',
    '',
    '| Session | Status | Reason | Models | Turns | Attempts | Cost (of which estimated) | Evidence |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const [k, s] of sessions) {
    if (!s.outcome) { lines.push(`| ${k} | not finished | stopped before its outcome | | | ${s.attempts.length} | | |`); continue; }
    const o = JSON.parse(fs.readFileSync(path.join(run, s.outcome.path, 'outcome.json'), 'utf8'));
    lines.push(`| ${k} | ${o.status} | ${[o.reason, o.ended_by && o.ended_by !== o.reason ? `ended by ${o.ended_by}` : null, o.hints && o.hints.length ? `${o.hints.length} hint(s)` : null, o.fallbacks ? `${o.fallbacks} fallback reply(ies)` : null].filter(Boolean).join('; ')} | ${o.seats.map(x => `${x.label}: ${x.model}`).join(', ')} | ${o.turns} | ${s.attempts.length} | ${$(o.cost.total_usd)} (${$(o.cost.estimated_usd)}) | ${s.outcome.path}/ |`);
  }
  lines.push('', '## Cost', '',
    `${$(t.total_usd)} of the ${$(study.spend.run_usd)} cap: reported by providers ${$(t.reported_usd)}, computed from reported tokens ${$(t.computed_usd)}, estimated (cost unknown, charged at the full reservation) ${$(t.estimated_usd)}${t.held_usd ? `, still held ${$(t.held_usd)}` : ''}.`,
    `Calls: ${events.filter(e => e.kind === 'call').length}; failed attempts: ${events.filter(e => e.kind === 'error').length}; retries: ${events.filter(e => e.kind === 'retry').length}; truncated replies: ${replies.filter(e => e.truncated).length}; refused for budget: ${events.filter(e => e.kind === 'budget').length}.`,
    '', 'Evidence: events.jsonl (every call, reply, retry and outcome), payloads/ (exact prompts and raw replies), ledger.jsonl (money), sessions/ (outcome.json and closing.md per session).', '');
  const text = lines.join('\n');
  fs.writeFileSync(path.join(run, 'report.md'), text, { mode: 0o600 });
  return text;
}

module.exports = { writeReport };
