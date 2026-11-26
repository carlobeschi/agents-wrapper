// @ts-check
// A run: every session of a study (cases x conditions x repeats), one after
// the other, in one run folder:
//
//   study.json      the exact study that ran (owner-only: it holds the secrets)
//   state.json      the checkpoint, rewritten after every session starts and ends
//   events.jsonl    the record (runner/events.js); payloads/ the texts
//   ledger.jsonl    the money (runner/budget.js)
//   sessions/<case>--<condition>--r<n>/<session id>/outcome.json, closing.md, and dialogue.md for an interview
//
// Resume is the same command on the same folder. A session with an outcome
// is never run again and never overwritten. A session that was started but
// has no outcome (the process stopped) runs again as a new attempt, with a
// new session id, and the record says which attempt it retries. Sessions
// stopped by the run's spend cap run again on resume (after the cap is
// raised); sessions that failed on a provider error run again only with
// retry_errors. The study file may not change between runs of one folder.

const fs = require('fs');
const path = require('path');
const { EventLog, newId, sha256 } = require('./events');
const { Ledger } = require('./budget');
const { checkStudy, providerOf } = require('./study');
const { runSession, seatsOf } = require('./session');

const writeJSON = (f, x) => { fs.writeFileSync(f + '.tmp', JSON.stringify(x, null, 2), { mode: 0o600 }); fs.renameSync(f + '.tmp', f); };

/** Outcomes that a plain resume does not run again. @param {any} s @param {boolean} retryErrors */
function settled(s, retryErrors) {
  if (!s || !s.outcome) return false;
  const r = s.outcome.reason || '';
  if (r === 'budget_run') return false;
  if (retryErrors && r.startsWith('error:')) return false;
  return true;
}

/**
 * @param {{ study: any, out: string, adapters: Record<string, any>, retry_errors?: boolean, run_usd?: number,
 *           say?: (line: string) => void, sleep?: (ms: number) => Promise<any>, backoff_ms?: number }} o
 */
async function runStudy(o) {
  const study = checkStudy(o.study);
  const say = o.say || (() => {});
  const missing = [...new Set(study.conditions.flatMap(c => Object.values(c.seats).flat().map(providerOf)))].filter(p => !o.adapters[p]);
  if (missing.length) throw new Error(`no adapter yet for: ${missing.join(', ')}`);

  fs.mkdirSync(o.out, { recursive: true, mode: 0o700 });
  const text = JSON.stringify(study, null, 2);
  const studyFile = path.join(o.out, 'study.json');
  const stateFile = path.join(o.out, 'state.json');
  /** @type {{ study_sha256: string, created: string, sessions: Record<string, any> }} */
  let state;
  if (fs.existsSync(stateFile)) {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (state.study_sha256 !== sha256(text)) throw new Error(`${o.out} was started with a different study file; use a new folder`);
  } else {
    fs.writeFileSync(studyFile, text, { mode: 0o600 });
    state = { study_sha256: sha256(text), created: new Date().toISOString(), sessions: {} };
    writeJSON(stateFile, state);
  }
  const log = new EventLog(o.out);
  const ledger = new Ledger({ file: path.join(o.out, 'ledger.jsonl'), run_usd: o.run_usd ?? study.spend.run_usd, session_usd: study.spend.session_usd, prices: study.prices });
  const run_attempt = newId('run');
  log.append({ kind: 'run', visible_to: [], evaluator_visible: true, run_attempt, study_sha256: state.study_sha256, title: study.title,
    run_usd: o.run_usd ?? study.spend.run_usd, resumed: Object.keys(state.sessions).length > 0 });

  const keys = [];
  for (const kase of study.cases) for (const condition of study.conditions) for (let r = 1; r <= study.repeats; r++) keys.push({ kase, condition, repeat: r, key: `${kase.id}--${condition.id}--r${r}` });

  let stopped = null;
  for (const [i, { kase, condition, repeat, key }] of keys.entries()) {
    const prev = state.sessions[key];
    if (settled(prev, !!o.retry_errors)) { say(`${i + 1}/${keys.length} ${key}: already ${prev.outcome.status}, kept`); continue; }
    const attempts = prev ? prev.attempts : [];
    const before = attempts[attempts.length - 1] || null;
    const session_id = newId('ses');
    attempts.push({ session_id, started: new Date().toISOString(), run_attempt });
    state.sessions[key] = { attempts, outcome: null };
    writeJSON(stateFile, state);
    const seats = seatsOf(study, condition).map(s => ({ seat: s.seat, role: s.roleName, kind: s.role.kind, model: s.model, label: s.label, prompt_version: s.role.prompt_version }));
    const start = log.append({ kind: 'session', session_id, visible_to: [], evaluator_visible: true, key, case: kase.id, condition: condition.id,
      pattern: condition.pattern, peer_consultation: !!condition.peer_consultation, repeat, seats, attempt: attempts.length,
      retry_of: before ? before.session_id : null, why_again: before ? (prev.outcome ? `previous outcome: ${prev.outcome.reason}` : 'previous attempt stopped before its outcome') : null });
    say(`${i + 1}/${keys.length} ${key}: running${before ? ` (attempt ${attempts.length})` : ''}`);

    const outcome = await runSession({ study, kase, condition, repeat, session_id, log, ledger, adapters: o.adapters, sleep: o.sleep, backoff_ms: o.backoff_ms });

    const dir = path.join(o.out, 'sessions', key, session_id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const money = ledger.totals(session_id);
    const result = { key, session_id, case: kase.id, condition: condition.id, repeat, seats, ...outcome, cost: money };
    writeJSON(path.join(dir, 'outcome.json'), result);
    if (outcome.closing_text != null) fs.writeFileSync(path.join(dir, 'closing.md'), outcome.closing_text, { mode: 0o600 });
    if (outcome.dialogue) fs.writeFileSync(path.join(dir, 'dialogue.md'), outcome.dialogue.map(d => `## ${d.n}. ${d.actor}${d.truncated ? ' (cut by the length limit)' : ''}\n\n${d.text}`).join('\n\n') + '\n', { mode: 0o600 });
    log.append({ kind: 'outcome', session_id, parent_id: start.event_id, visible_to: [], evaluator_visible: true, key,
      status: outcome.status, reason: outcome.reason, ended_by: outcome.ended_by ?? null, hints: outcome.hints ? outcome.hints.length : null, turns: outcome.turns, closing_seat: outcome.closing_seat,
      final_ref: outcome.final != null ? log.put(outcome.final) : null, cost_usd: money.total_usd, cost_estimated_usd: money.estimated_usd });
    attempts[attempts.length - 1].ended = new Date().toISOString();
    state.sessions[key] = { attempts, outcome: { status: outcome.status, reason: outcome.reason, session_id, path: path.relative(o.out, dir) } };
    writeJSON(stateFile, state);
    say(`${i + 1}/${keys.length} ${key}: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''}, $${money.total_usd.toFixed(4)}`);
    if (outcome.reason === 'budget_run') { stopped = 'the run spend cap'; break; }
  }
  const t = ledger.totals();
  say(`Spent $${t.total_usd.toFixed(4)} of $${o.run_usd ?? study.spend.run_usd} (of which estimated $${t.estimated_usd.toFixed(4)}).${stopped ? ` Stopped by ${stopped}; raise it and resume to go on.` : ''}`);
  return { state, totals: t, stopped };
}

module.exports = { runStudy };
