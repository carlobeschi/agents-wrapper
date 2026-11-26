// @ts-check
// What a role is shown. A prompt is built only from the sources the role's
// "sees" allows (task, materials, secret, transcript), and checked once more
// before it leaves: a prompt for a role that may not see the secret is refused
// if the secret's text is in it, wherever it came from (a material, another
// agent's reply that quoted it, a slip in a prompt). Other agents are named
// by neutral seat labels ("Expert 1"), never by model, and are said to be AI
// models, which they are.

const crypto = require('crypto');

class SecretLeak extends Error {
  /** @param {string} message */
  constructor(message) { super(message); this.name = 'SecretLeak'; }
}

/**
 * A small seeded random generator (mulberry32 over a hash of the key), so a
 * shuffled order is the same every time the same study runs.
 * @param {string} key
 */
function rng(key) {
  let a = crypto.createHash('sha256').update(String(key)).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @template T @param {T[]} xs @param {string} key */
function shuffled(xs, key) {
  const r = rng(key), out = [...xs];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

/** The line the closing role must write, and how to end early instead. @param {any} kase */
const finalRule = (kase) => `When you are ready, end your reply with a line that starts with "${kase.final_answer.marker}" followed by your final answer. `
  + 'If you cannot give one, write a line that starts with "EARLY END:" and say why. A reply without either line is not a final answer.';

/**
 * Builds the messages for one call.
 * @param {{ role: any, roleName: string, kase: any,
 *           transcript?: { label: string, text: string }[],
 *           closing?: boolean, extra?: string[] }} o
 */
function view({ role, roleName, kase, transcript = [], closing = false, extra = [] }) {
  const sees = new Set(role.sees);
  const parts = [];
  if (sees.has('task')) parts.push(`## The task\n\n${kase.task}`);
  if (sees.has('materials')) {
    for (const [name, text] of Object.entries(kase.materials || {})) parts.push(`## Material: ${name}\n\n${text}`);
  }
  if (sees.has('secret') && kase.secret) parts.push(`## Reference notes (not seen by the participants)\n\n${kase.secret}`);
  if (sees.has('transcript') && transcript.length) {
    parts.push('## What the others wrote\n\nThe others are AI models. Their names are hidden.\n\n'
      + transcript.map(t => `### ${t.label}\n\n${t.text}`).join('\n\n'));
  }
  parts.push(...extra);
  if (closing) parts.push(finalRule(kase));
  const messages = [
    { role: /** @type {'system'} */ ('system'), content: role.prompt },
    { role: /** @type {'user'} */ ('user'), content: parts.join('\n\n') },
  ];
  guard(messages, role, roleName, kase);
  return messages;
}

/**
 * Refuses a prompt that would show the secret to a role not allowed to see it.
 * @param {{ content: string }[]} messages @param {any} role @param {string} roleName @param {any} kase
 */
function guard(messages, role, roleName, kase) {
  if (role.sees.includes('secret')) return;
  const hidden = [kase.secret, ...(kase.never_disclose || [])].map(x => x && String(x).trim()).filter(Boolean);
  for (const h of hidden) {
    if (messages.some(m => m.content.includes(h))) {
      throw new SecretLeak(`${h === String(kase.secret).trim() ? 'the secret' : 'a never_disclose text'} of case ${kase.id} would reach ${roleName} (${role.kind}); the call was not made`);
    }
  }
}

/**
 * Where a reply ends: complete (the marker line, and what follows it), ended
 * early (EARLY END: reason), or neither.
 * @param {string} text @param {string} marker
 */
function finalOf(text, marker) {
  const lines = String(text).split('\n');
  const at = lines.findIndex(l => l.trim().startsWith(marker));
  if (at >= 0) {
    const answer = [lines[at].trim().slice(marker.length), ...lines.slice(at + 1)].join('\n').trim();
    if (answer) return { kind: 'final', answer };
  }
  const early = lines.find(l => l.trim().startsWith('EARLY END:'));
  if (early) return { kind: 'early', answer: early.trim().slice('EARLY END:'.length).trim() };
  return { kind: 'none', answer: '' };
}

module.exports = { view, guard, finalOf, finalRule, shuffled, rng, SecretLeak };
