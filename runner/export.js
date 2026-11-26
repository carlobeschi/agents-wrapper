// @ts-check
// Blinded evaluation packets: one per session, for judges (people or
// models) who must not know which condition or model made it.
//
//   <run>/exports/<export id>/packets/<random id>.json   what a judge reads
//   <run>/exports/<export id>/manifest.json              what the judges were shown, and the residual leakage note
//   <run>/exports/<export id>.key.json                   packet -> session, condition, models (outside the packets folder)
//
// A packet holds the case's task and, as chosen with "sees": "source" (the
// materials and the reference notes), "answer" (the closing reply) and
// "discussion" (the analyses the moderator read, as "Expert 1", "Expert 2").
// Every packet records what was shown, so each rating can say what its judge saw.
// Packet ids are random; the order is shuffled with the seed. Model ids and
// vendor names are taken out of every text and listed in the key, not in the
// packet. What cannot be taken out is written in the manifest: style gives
// models away, and a packet with a discussion comes from a team.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventLog } = require('./events');
const { shuffled } = require('./view');

const VENDORS = ['Anthropic', 'Claude', 'OpenAI', 'ChatGPT', 'GPT', 'Codex', 'Google', 'Gemini', 'DeepMind', 'DeepSeek', 'Mistral', 'Qwen', 'Alibaba', 'Meta', 'Llama', 'OpenRouter', 'Opus', 'Sonnet', 'Haiku', 'Fable'];
const SEES = ['source', 'answer', 'discussion'];
const RESIDUAL = [
  'Writing style, length and habits can still show which model wrote an answer.',
  'A packet with a discussion comes from a team condition; one without may be solo. Showing the discussion reveals the pattern.',
  'What a role could see shapes what it writes: an answer that quotes materials the condition did not show is a clue.',
  'Only model ids and vendor names are removed from the text; a model may describe itself in other words.',
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Labels that must not reach a judge, longest first. @param {any} study */
function labelsOf(study) {
  const models = new Set();
  for (const c of study.conditions) for (const m of Object.values(c.seats).flat()) {
    const id = String(m);
    models.add(id);
    const name = id.slice(id.indexOf(':') + 1);
    models.add(name);
    if (name.includes('/')) models.add(name.split('/').pop());
  }
  return { models: [...models].filter(x => x.length > 2), vendors: VENDORS, conditions: study.conditions.map(c => c.id) };
}

/** Takes the labels out of a text, and counts what it took. @param {string} text @param {{ models: string[], vendors: string[] }} labels */
function scrub(text, labels) {
  let n = 0;
  let out = String(text);
  for (const l of [...labels.models, ...labels.vendors].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(?<![\\w-])${esc(l)}(?![\\w])`, 'gi'), () => { n++; return '[model]'; });
  }
  return { text: out, removed: n };
}

/**
 * Field names, filenames or values that would tell a judge the condition or
 * the model. Empty when the folder looks clean.
 * @param {string} packetsDir @param {{ models: string[], vendors: string[], conditions: string[] }} labels
 */
function leaks(packetsDir, labels) {
  const found = [];
  const banned = /^(arm|condition|conditions|model|models|seat|seats|provider|pattern|session|session_id|key)$/i;
  for (const f of fs.readdirSync(packetsDir)) {
    if (!/^p_[0-9a-f]{12}\.json$/.test(f)) found.push(`filename ${f}`);
    for (const l of [...labels.models, ...labels.conditions]) if (f.toLowerCase().includes(l.toLowerCase())) found.push(`filename ${f} has "${l}"`);
    const walk = (x, at) => {
      if (Array.isArray(x)) return x.forEach((v, i) => walk(v, `${at}[${i}]`));
      if (x && typeof x === 'object') {
        for (const [k, v] of Object.entries(x)) { if (banned.test(k)) found.push(`${f}: field ${at}.${k}`); walk(v, `${at}.${k}`); }
        return;
      }
      if (typeof x !== 'string') return;
      if (labels.conditions.includes(x)) found.push(`${f}: ${at} is the condition id "${x}"`);
      for (const l of [...labels.models, ...labels.vendors]) if (new RegExp(`(?<![\\w-])${esc(l)}(?![\\w])`, 'i').test(x)) found.push(`${f}: ${at} names "${l}"`);
    };
    walk(JSON.parse(fs.readFileSync(path.join(packetsDir, f), 'utf8')), '$');
  }
  return found;
}

/**
 * @param {{ run: string, sees?: string[], seed?: number, only_complete?: boolean }} o
 */
function exportPackets(o) {
  const sees = o.sees || ['answer'];
  for (const s of sees) if (!SEES.includes(s)) throw new Error(`sees: "${s}" is not one of ${SEES.join(', ')}`);
  const study = JSON.parse(fs.readFileSync(path.join(o.run, 'study.json'), 'utf8'));
  const state = JSON.parse(fs.readFileSync(path.join(o.run, 'state.json'), 'utf8'));
  const log = new EventLog(o.run);
  const events = log.all();
  const labels = labelsOf(study);
  const export_id = `x_${crypto.randomBytes(6).toString('hex')}`;
  const dir = path.join(o.run, 'exports', export_id);
  const packetsDir = path.join(dir, 'packets');
  fs.mkdirSync(packetsDir, { recursive: true, mode: 0o700 });

  const rows = Object.entries(state.sessions).filter(([, s]) => s.outcome && (!o.only_complete || s.outcome.status === 'complete'));
  const order = shuffled(rows.map((_, i) => i), `${o.seed ?? study.seed ?? 0}:${export_id}`);
  const key = { export_id, run: path.basename(o.run), created: new Date().toISOString(), sees, packets: [] };
  for (const i of order) {
    const [k, s] = rows[i];
    const outcome = JSON.parse(fs.readFileSync(path.join(o.run, s.outcome.path, 'outcome.json'), 'utf8'));
    const kase = study.cases.find(c => c.id === outcome.case);
    let removed = 0;
    const clean = (t) => { const r = scrub(t, labels); removed += r.removed; return r.text; };
    const packet_id = `p_${crypto.randomBytes(6).toString('hex')}`;
    /** @type {any} */
    const packet = { packet_id, case: kase.id, task: kase.task, shown: Object.fromEntries(SEES.map(x => [x, sees.includes(x)])),
      status: s.outcome.status === 'complete' ? 'final answer given' : s.outcome.status === 'ended_early' ? 'ended early' : 'no final answer' };
    if (sees.includes('source')) { packet.materials = kase.materials || {}; packet.reference = kase.secret || null; }
    if (sees.includes('answer')) packet.answer = outcome.closing_text == null ? null : clean(outcome.closing_text);
    if (sees.includes('discussion')) {
      const order_ev = events.find(e => e.session_id === s.outcome.session_id && e.what === 'moderator order');
      packet.discussion = order_ev ? order_ev.order.map(x => {
        const reply = events.find(e => e.event_id === x.from_event);
        return { label: x.label, text: clean(reply ? log.get(reply.text_ref) : '') };
      }) : [];
    }
    fs.writeFileSync(path.join(packetsDir, `${packet_id}.json`), JSON.stringify(packet, null, 2), { mode: 0o600 });
    key.packets.push({ packet_id, key: k, session_id: s.outcome.session_id, case: outcome.case, condition: outcome.condition, repeat: outcome.repeat,
      models: outcome.seats.map(x => x.model), families: [...new Set(outcome.seats.map(x => familyOf(x.model)))], status: s.outcome.status, labels_removed: removed });
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ export_id, sees, packets: key.packets.length,
    dimensions: DIMENSIONS, residual_leakage: RESIDUAL, note: 'The key is kept outside this folder. Model judges are not independent ground truth.' }, null, 2), { mode: 0o600 });
  const keyFile = path.join(o.run, 'exports', `${export_id}.key.json`);
  fs.writeFileSync(keyFile, JSON.stringify(key, null, 2), { mode: 0o600 });
  return { export_id, dir, packetsDir, keyFile, key, leaks: leaks(packetsDir, labels) };
}

// The four separate dimensions a judge scores, 1 to 10.
const DIMENSIONS = {
  perspective_coverage: 'Does the answer weigh the perspectives and options the case calls for?',
  factual_support: 'Is every claim supported by the case materials, with nothing invented?',
  decision_quality: 'Is the final recommendation sound, specific and actionable?',
  information_transfer: 'Did what each participant found reach the final answer? (Score only if the discussion is shown.)',
};

/**
 * A model's family, for judge independence: the vendor, not the version.
 * @param {string} model
 */
function familyOf(model) {
  const i = model.indexOf(':');
  const p = model.slice(0, i), name = model.slice(i + 1);
  if (p === 'anthropic') return 'claude';
  if (p === 'openai') return 'gpt';
  if (p === 'google') return 'gemini';
  if (p === 'openrouter') {
    const vendor = name.split('/')[0].toLowerCase();
    return { anthropic: 'claude', openai: 'gpt', google: 'gemini', 'meta-llama': 'llama', mistralai: 'mistral', 'x-ai': 'grok' }[vendor] || vendor;
  }
  return `${p}:${name}`;
}

module.exports = { exportPackets, leaks, scrub, labelsOf, familyOf, DIMENSIONS, RESIDUAL };
