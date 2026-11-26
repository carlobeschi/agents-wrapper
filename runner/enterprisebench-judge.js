// @ts-check
// Prototype: construct the paper's consulting judge input and validate scores.
// The caller supplies the captured judge system prompt and a budgeted provider call.
// Never replace an invalid or truncated score with zero.
//
// Adapted from FirmBench (EnterpriseBench), https://github.com/sduyangmin/FirmBench
// at commit fe0edb02bfa298c0f407468255e2dbdf73f4b65b, Apache License 2.0;
// rewritten in JavaScript and changed for this runner.
const dimensions = ['structure', 'quant', 'business_sense', 'communication'];
const END = '<|CASE_INTERVIEW_END|>';

/** @param {string} systemPrompt @param {string} caseText @param {{ actor: string, text: string }[]} dialogue */
function judgeMessages(systemPrompt, caseText, dialogue) {
  const transcript = dialogue.map(x => `${x.actor.toUpperCase()}: ${x.text.includes(END) ? x.text.split(END).join('').trim() : x.text}`).join('\n');
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'You are now given a consulting case and the full dialogue between interviewer and candidate.\n\n'
      + '=== CASE TEXT ===\n' + caseText + '\n\n=== DIALOGUE TRANSCRIPT ===\n' + transcript + '\n\n'
      + "Evaluate the CANDIDATE's performance only (do not evaluate the interviewer), strictly following the scoring instructions. Return ONLY the JSON object." },
  ];
}

/** @param {string} text @param {boolean} [truncated] */
function validateScore(text, truncated = false) {
  if (truncated) throw Error('judge reply truncated');
  let value;
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  try { value = JSON.parse(fenced ? fenced[1] : trimmed); } catch { throw Error('judge reply is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('judge reply is not an object');
  for (const key of [...dimensions, 'overall']) if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0 || value[key] > 10) throw Error(`invalid ${key}`);
  if (typeof value.feedback !== 'string' || !value.feedback.trim()) throw Error('invalid feedback');
  return { ...value, dimension_mean: dimensions.reduce((sum, key) => sum + value[key], 0) / dimensions.length };
}

module.exports = { dimensions, judgeMessages, validateScore };
