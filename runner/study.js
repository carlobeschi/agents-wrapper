// @ts-check
// The study file: what a run of the research runner is, read and checked before
// any model is called. Plain JSON, so a researcher can write it by hand and a
// run folder can keep an exact copy of what was run.
//
// {
//   "title": "Two consulting cases",
//   "version": 1,                         (this format; only 1 exists)
//   "seed": 7,                            (passed to providers that honour one; recorded either way)
//   "repeats": 1,
//   "spend": { "run_usd": 5, "session_usd": 1 },
//   "prices": { "anthropic:claude-opus-5-5": { "in_per_mtok": 0, "out_per_mtok": 0, "as_of": "YYYY-MM-DD" } },
//   "limits": { "turns": 8, "max_output_tokens": 2000, "timeout_s": 120, "retries": 2 },
//   "roles": {
//     "expert":    { "kind": "expert",    "prompt": "You are ...", "prompt_version": "v1", "sees": ["task", "materials"] },
//     "moderator": { "kind": "moderator", "prompt": "...",          "prompt_version": "v1", "sees": ["task", "transcript"] },
//     "judge":     { "kind": "judge",     "prompt": "...",          "prompt_version": "v1", "sees": ["task", "secret", "transcript"] }
//   },
//   "cases": [ { "id": "case-a", "task": "what every participant is told",
//                "materials": { "brief.md": "text the roles that see materials may read" },
//                "secret": "the solution: never shown to a participant",
//                "final_answer": { "marker": "FINAL RECOMMENDATION:" } } ],
//   "conditions": [
//     { "id": "solo",  "pattern": "solo",              "seats": { "expert": "anthropic:claude-opus-5-5" } },
//     { "id": "mixed", "pattern": "experts_moderator", "seats": { "expert": ["openai:gpt-6-luna", "google:gemini-4-argon-medium"],
//                                                                 "moderator": "anthropic:claude-opus-5-5" },
//       "peer_consultation": false },
//     { "id": "interview-solo", "pattern": "interview", "seats": { "interviewer": "openai:...", "candidate": "anthropic:..." },
//       "max_messages": 12, "end_token": "<|CASE_INTERVIEW_END|>", "hint_marker": "HINT:", "last_turn_notice": false }
//   ],
//   "adaptations": ["how this study differs from the one it follows, printed in the report"]
// }
//
// A case may list "never_disclose": pieces of the hidden material (the
// reference solution, interviewer notes) that must not reach a participant,
// checked before every call like the secret itself. A role may set
// "temperature" (sent to every provider; left out, the provider's default).
//
// What a role may see ("sees") is the only way information reaches a prompt.
// "secret" may be seen by an interviewer or a judge only; a study that shows it
// to a candidate, an expert or a moderator is refused here, before any call.

const KINDS = ['candidate', 'expert', 'moderator', 'interviewer', 'judge'];
const PATTERNS = ['solo', 'experts_moderator', 'interview'];
const SOURCES = ['task', 'materials', 'secret', 'transcript'];
const SECRET_OK = ['interviewer', 'judge'];
const PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter', 'fake'];

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** @param {string} model */
function providerOf(model) {
  const i = String(model).indexOf(':');
  return i > 0 ? model.slice(0, i) : '';
}

/**
 * Checks a parsed study and returns it with defaults filled in. Throws one
 * Error listing every problem, so a researcher fixes them in one go.
 * @param {any} s
 */
function checkStudy(s) {
  const errs = [];
  const need = (ok, msg) => { if (!ok) errs.push(msg); };
  const num = (x, min = 0) => typeof x === 'number' && Number.isFinite(x) && x >= min;
  if (!s || typeof s !== 'object') throw new Error('study: not a JSON object');

  need(typeof s.title === 'string' && s.title.trim(), 'title: required');
  need(s.version === 1, 'version: must be 1');
  need(s.seed === undefined || Number.isInteger(s.seed), 'seed: a whole number, or left out');
  need(s.repeats === undefined || (Number.isInteger(s.repeats) && s.repeats >= 1), 'repeats: a whole number from 1');

  const spend = s.spend || {};
  need(num(spend.run_usd) && spend.run_usd > 0, 'spend.run_usd: required, more than 0 (the most the whole run may spend)');
  need(spend.session_usd === undefined || (num(spend.session_usd) && spend.session_usd > 0), 'spend.session_usd: more than 0, or left out');

  const limits = { turns: 8, max_output_tokens: 2000, timeout_s: 120, retries: 2, ...(s.limits || {}) };
  need(Number.isInteger(limits.turns) && limits.turns >= 1, 'limits.turns: a whole number from 1');
  need(Number.isInteger(limits.max_output_tokens) && limits.max_output_tokens >= 1, 'limits.max_output_tokens: a whole number from 1');
  need(num(limits.timeout_s) && limits.timeout_s > 0, 'limits.timeout_s: more than 0');
  need(Number.isInteger(limits.retries) && limits.retries >= 0 && limits.retries <= 5, 'limits.retries: 0 to 5');

  const roles = s.roles && typeof s.roles === 'object' ? s.roles : {};
  need(Object.keys(roles).length > 0, 'roles: at least one');
  for (const [name, r] of Object.entries(roles)) {
    const at = `roles.${name}`;
    need(ID.test(name), `${at}: name must be lower-case letters, digits, . _ -`);
    need(r && KINDS.includes(r.kind), `${at}.kind: one of ${KINDS.join(', ')}`);
    need(r && typeof r.prompt === 'string' && r.prompt.trim(), `${at}.prompt: required`);
    need(r && typeof r.prompt_version === 'string' && r.prompt_version.trim(), `${at}.prompt_version: required (saved with every call)`);
    const sees = r && Array.isArray(r.sees) ? r.sees : null;
    need(sees, `${at}.sees: a list from ${SOURCES.join(', ')}`);
    for (const x of sees || []) need(SOURCES.includes(x), `${at}.sees: "${x}" is not one of ${SOURCES.join(', ')}`);
    if (sees && sees.includes('secret') && r && !SECRET_OK.includes(r.kind)) {
      errs.push(`${at}: a ${r.kind} may not see "secret" (only ${SECRET_OK.join(' or ')})`);
    }
    need(!r || r.max_output_tokens === undefined || (Number.isInteger(r.max_output_tokens) && r.max_output_tokens >= 1), `${at}.max_output_tokens: a whole number from 1`);
    need(!r || r.temperature === undefined || (num(r.temperature) && r.temperature <= 2), `${at}.temperature: 0 to 2, or left out (the provider's default)`);
  }
  need(s.adaptations === undefined || (Array.isArray(s.adaptations) && s.adaptations.every(a => typeof a === 'string')), 'adaptations: a list of texts (how this study differs from the one it follows)');

  const cases = Array.isArray(s.cases) ? s.cases : [];
  need(cases.length > 0, 'cases: at least one');
  const caseIds = new Set();
  for (const [i, c] of cases.entries()) {
    const at = `cases[${i}]`;
    need(c && ID.test(c.id || ''), `${at}.id: lower-case letters, digits, . _ -`);
    need(c && !caseIds.has(c.id), `${at}.id: "${c && c.id}" appears twice`);
    if (c) caseIds.add(c.id);
    need(c && typeof c.task === 'string' && c.task.trim(), `${at}.task: required (what every participant is told)`);
    need(c && (c.materials === undefined || (typeof c.materials === 'object' && Object.values(c.materials).every(v => typeof v === 'string'))), `${at}.materials: { name: text }`);
    need(c && (c.secret === undefined || typeof c.secret === 'string'), `${at}.secret: text`);
    need(c && (c.never_disclose === undefined || (Array.isArray(c.never_disclose) && c.never_disclose.every(x => typeof x === 'string' && x.trim()))),
      `${at}.never_disclose: a list of texts from the hidden material that must not reach a participant`);
    const fa = c && c.final_answer;
    need(fa && typeof fa.marker === 'string' && fa.marker.trim(), `${at}.final_answer.marker: required (the text that starts a complete final answer)`);
    if (c && typeof c.secret === 'string' && c.secret.trim()) {
      need(!String(c.task).includes(c.secret.trim()), `${at}: the secret is written inside the task`);
      for (const [m, text] of Object.entries(c.materials || {})) need(!String(text).includes(c.secret.trim()), `${at}: the secret is written inside materials "${m}"`);
    }
  }

  const prices = s.prices && typeof s.prices === 'object' ? s.prices : {};
  const conditions = Array.isArray(s.conditions) ? s.conditions : [];
  need(conditions.length > 0, 'conditions: at least one');
  const condIds = new Set();
  for (const [i, c] of conditions.entries()) {
    const at = `conditions[${i}]`;
    need(c && ID.test(c.id || ''), `${at}.id: lower-case letters, digits, . _ -`);
    need(c && !condIds.has(c.id), `${at}.id: "${c && c.id}" appears twice`);
    if (c) condIds.add(c.id);
    need(c && PATTERNS.includes(c.pattern), `${at}.pattern: one of ${PATTERNS.join(', ')}`);
    const seats = c && c.seats && typeof c.seats === 'object' ? c.seats : {};
    need(Object.keys(seats).length > 0, `${at}.seats: { role: model or [models] }`);
    for (const [role, m] of Object.entries(seats)) {
      need(roles[role], `${at}.seats.${role}: no such role`);
      const models = Array.isArray(m) ? m : [m];
      need(models.length > 0, `${at}.seats.${role}: at least one model`);
      for (const model of models) {
        need(typeof model === 'string' && PROVIDERS.includes(providerOf(model)) && model.length > providerOf(model).length + 1,
          `${at}.seats.${role}: "${model}" must be provider:model, provider one of ${PROVIDERS.join(', ')}`);
        if (typeof model === 'string' && providerOf(model) !== 'fake') {
          const p = prices[model];
          need(p && num(p.in_per_mtok) && num(p.out_per_mtok) && typeof p.as_of === 'string',
            `prices["${model}"]: needed, { in_per_mtok, out_per_mtok, as_of } in USD per million tokens, so the budget can be reserved`);
        }
      }
    }
    if (c && c.pattern === 'solo') {
      const people = Object.entries(seats).filter(([r]) => roles[r] && ['candidate', 'expert'].includes(roles[r].kind));
      need(people.length === 1 && [people[0][1]].flat().length === 1, `${at}: solo needs exactly one candidate or expert seat with one model`);
    }
    if (c && c.pattern === 'experts_moderator') {
      const kinds = Object.keys(seats).map(r => roles[r] && roles[r].kind);
      need(kinds.includes('expert'), `${at}: experts_moderator needs an expert seat`);
      need(kinds.includes('moderator'), `${at}: experts_moderator needs a moderator seat`);
    }
    if (c && c.pattern === 'interview') {
      const kinds = Object.entries(seats).map(([r, m]) => ({ kind: roles[r] && roles[r].kind, n: [m].flat().length, role: roles[r] }));
      const iv = kinds.filter(k => k.kind === 'interviewer');
      need(iv.length === 1 && iv[0].n === 1, `${at}: interview needs exactly one interviewer seat with one model`);
      const solo = kinds.filter(k => k.kind === 'candidate');
      const experts = kinds.filter(k => k.kind === 'expert');
      const mods = kinds.filter(k => k.kind === 'moderator');
      need((solo.length === 1 && solo[0].n === 1 && !experts.length && !mods.length) || (!solo.length && experts.length >= 1 && mods.length === 1 && mods[0].n === 1),
        `${at}: interview needs either one candidate seat (one model), or expert seats and one moderator seat (one model)`);
      for (const m of mods) need(m.role && m.role.sees.includes('transcript'), `${at}: the moderator of an interview panel must see "transcript" (the experts' proposals)`);
      need(c.max_messages === undefined || (Number.isInteger(c.max_messages) && c.max_messages >= 2), `${at}.max_messages: a whole number from 2 (interviewer and candidate messages both count)`);
      need(c.end_token === undefined || (typeof c.end_token === 'string' && c.end_token.trim()), `${at}.end_token: text`);
      need(c.hint_marker === undefined || c.hint_marker === null || (typeof c.hint_marker === 'string' && c.hint_marker.trim()), `${at}.hint_marker: text, or null for none`);
      need(c.last_turn_notice === undefined || typeof c.last_turn_notice === 'boolean', `${at}.last_turn_notice: true or false`);
      need(c.candidate_marker_instruction === undefined || typeof c.candidate_marker_instruction === 'boolean', `${at}.candidate_marker_instruction: true or false`);
      need(c.expert_order === undefined || ['fixed', 'shuffled'].includes(c.expert_order), `${at}.expert_order: fixed or shuffled`);
      need(c.paper_prompts === undefined || typeof c.paper_prompts === 'boolean', `${at}.paper_prompts: true or false`);
      if (c.paper_prompts) {
        need(iv[0] && iv[0].role && iv[0].role.sees.includes('secret'), `${at}: paper interviewer must see the full case secret`);
        need(c.end_token === undefined || c.end_token === '<|CASE_INTERVIEW_END|>', `${at}: paper end token must match the renderer`);
        need(!c.last_turn_notice && c.candidate_marker_instruction === false && c.hint_marker === null, `${at}: paper prompts require no added final notice, marker or hint marker`);
        need(!experts.length || experts.reduce((sum, x) => sum + x.n, 0) === 3, `${at}: paper discussion requires three experts`);
      }
    }
    need(c && (c.peer_consultation === undefined || typeof c.peer_consultation === 'boolean'), `${at}.peer_consultation: true or false`);
  }

  if (errs.length) throw new Error('study is not valid:\n- ' + errs.join('\n- '));
  return { ...s, repeats: s.repeats || 1, limits, prices, spend: { session_usd: null, ...spend } };
}

module.exports = { checkStudy, providerOf, KINDS, PATTERNS, SOURCES };
