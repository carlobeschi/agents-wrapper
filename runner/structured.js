// @ts-check
// Structured replies (actions, scores): one JSON object, checked against a
// small schema, asked for again a bounded number of times when it is not
// valid. Plain text stays the default for discussion; this is only for the
// few places where the runner must read a value.
//
// The reply is asked for as text, the same way from every provider (a JSON
// object, alone or in a ```json block), so the providers are compared on the
// same request; native schema modes are not used in this version. Every
// attempt is an ordinary call (runner/call.js): recorded, charged, with its
// own attempt id. A reply cut by the length limit is never repaired: it
// counts as an invalid attempt. When the attempts run out, StructuredError
// carries every reply and every reason.
//
// Schema subset: { type: object|array|string|number|integer|boolean, properties,
// required, additionalProperties: false, items, enum, minimum, maximum, minLength, maxItems }.

const { callModel } = require('./call');

class StructuredError extends Error {
  /** @param {string} message @param {{ text: string, problems: string[] }[]} tries */
  constructor(message, tries) { super(message); this.name = 'StructuredError'; this.tries = tries; }
}

/**
 * Problems with a value against the schema; empty when it fits.
 * @param {any} v @param {any} s @param {string} [at]
 * @returns {string[]}
 */
function validate(v, s, at = '$') {
  const out = [];
  const typeOk = {
    object: () => v !== null && typeof v === 'object' && !Array.isArray(v),
    array: () => Array.isArray(v),
    string: () => typeof v === 'string',
    number: () => typeof v === 'number' && Number.isFinite(v),
    integer: () => Number.isInteger(v),
    boolean: () => typeof v === 'boolean',
  };
  if (s.type && !(typeOk[s.type] && typeOk[s.type]())) return [`${at}: should be ${s.type}`];
  if (s.enum && !s.enum.includes(v)) out.push(`${at}: should be one of ${s.enum.map(x => JSON.stringify(x)).join(', ')}`);
  if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) out.push(`${at}: should be at least ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) out.push(`${at}: should be at most ${s.maximum}`);
  }
  if (typeof v === 'string' && s.minLength !== undefined && v.length < s.minLength) out.push(`${at}: should have at least ${s.minLength} characters`);
  if (Array.isArray(v)) {
    if (s.maxItems !== undefined && v.length > s.maxItems) out.push(`${at}: should have at most ${s.maxItems} items`);
    if (s.items) v.forEach((x, i) => out.push(...validate(x, s.items, `${at}[${i}]`)));
  }
  if (s.type === 'object') {
    for (const k of s.required || []) if (!(k in v)) out.push(`${at}.${k}: missing`);
    for (const [k, sub] of Object.entries(s.properties || {})) if (k in v) out.push(...validate(v[k], sub, `${at}.${k}`));
    if (s.additionalProperties === false) for (const k of Object.keys(v)) if (!(k in (s.properties || {}))) out.push(`${at}.${k}: not allowed`);
  }
  return out;
}

/** The JSON object in a reply: the whole text, or the first ```json block. @param {string} text */
function extract(text) {
  const t = String(text).trim();
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/.exec(t);
  const body = fenced ? fenced[1] : t;
  try { return { ok: true, value: JSON.parse(body) }; } catch (e) { return { ok: false, problem: `not valid JSON (${e.message})` }; }
}

/**
 * One structured call. Takes what callModel takes, plus schema and tries.
 * @param {Parameters<typeof callModel>[0] & { schema: any, tries?: number }} o
 */
async function callStructured(o) {
  const tries = o.tries ?? 3;
  const ask = 'Reply with one JSON object and nothing else, matching this JSON schema:\n```json\n' + JSON.stringify(o.schema, null, 2) + '\n```';
  /** @type {{ text: string, problems: string[] }[]} */
  const seen = [];
  let parent = o.parent_id ?? null;
  for (let n = 0; n < tries; n++) {
    const messages = [...o.messages];
    const last = messages[messages.length - 1];
    const again = seen.length ? `\n\nYour previous reply could not be used: ${seen[seen.length - 1].problems.join('; ')}. Send the whole object again.` : '';
    messages[messages.length - 1] = { ...last, content: `${last.content}\n\n${ask}${again}` };
    const r = await callModel({ ...o, messages, parent_id: parent });
    parent = r.event_id;
    const problems = [];
    let value;
    if (r.truncated) problems.push('cut off by the length limit');
    else if (r.stop === 'refusal') problems.push('the model declined');
    else {
      const x = extract(r.text);
      if (!x.ok) problems.push(x.problem);
      else { value = x.value; problems.push(...validate(value, o.schema)); }
    }
    o.log.append({ kind: 'note', session_id: o.session_id, attempt_id: r.attempt_id, parent_id: r.event_id, role: o.role,
      visible_to: [], evaluator_visible: true, what: 'structured check', valid: problems.length === 0, problems, try: n + 1, of: tries });
    if (!problems.length) return { value, reply: r, tries: n + 1 };
    seen.push({ text: r.text, problems });
  }
  throw new StructuredError(`no valid reply in ${tries} tries: ${seen[seen.length - 1].problems.join('; ')}`, seen);
}

module.exports = { callStructured, validate, extract, StructuredError };
