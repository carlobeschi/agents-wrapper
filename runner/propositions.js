// @ts-check
// Proposition-level review of a blinded export: one shared inventory of
// atomic propositions, two independent coders, agreement, adjudication, and
// only then the key.
//
//   <export>/propositions/codebook.json            the codebook used (fields and allowed values), frozen
//   <export>/propositions/inventory.json           the shared inventory, frozen: its bytes never change
//   <export>/propositions/coders/<coder>.jsonl     one coder's rows, frozen when imported
//   <export>/propositions/coders/<coder>.suggestions.jsonl   items the coder thinks are missing (never counted)
//   <export>/propositions/frozen.json              sha256 and time of everything frozen
//   <export>/propositions/agreement.json           raw agreement, confusion matrices, prevalence, kappa where it means something
//   <export>/propositions/adjudications.jsonl      a person's resolution of each difference, with evidence; never overwrites a rating
//
// Order, enforced: freeze the inventory (made by an extractor blind to the
// key and to the coders) -> each coder codes from a coding kit (packets,
// inventory, codebook; never the key or the other coder's file) -> both
// coders' files are frozen -> agreement -> every difference adjudicated ->
// unblind. Quotes and offsets are checked against the exact packet text.
//
// Sources of a packet, numbered from 1: the discussion entries ("Expert 1",
// "Expert 2"...) when the packet has a discussion; otherwise the answer
// itself (solo). Answer quotes are checked against the answer and the
// candidate's messages in the dialogue.

const fs = require('fs');
const path = require('path');
const { sha256 } = require('./events');

const DEFAULT_CODEBOOK = {
  version: 'openresearch-shared-propositions-draft-2026-11-26',
  note: 'Under calibration; not validated. Hidden is a visibility attribute, not a verdict: visible_support and reference_support are separate.',
  fields: {
    source_presence: ['present', 'partial', 'absent', 'unclear'],
    moderator_treatment: ['included', 'changed_qualification', 'omitted', 'contradicted', 'unclear', 'not_applicable'],
    visible_support: ['supported', 'contradicted', 'unsupported_unknown', 'not_assessable'],
    reference_support: ['supported', 'contradicted', 'unsupported_unknown', 'not_assessable'],
  },
  text_fields: ['source_quote', 'answer_quote', 'rationale'],
  solo_field: 'moderator_treatment',
  solo_value: 'not_applicable',
};

const dirOf = (exportDir) => path.join(exportDir, 'propositions');
const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const readJSONL = (f) => fs.readFileSync(f, 'utf8').split('\n').map(l => l.trim()).filter(Boolean).map((l, i) => { try { return JSON.parse(l); } catch { throw new Error(`${path.basename(f)} line ${i + 1}: not JSON`); } });
const readAny = (f) => { const t = fs.readFileSync(f, 'utf8').trim(); return t.startsWith('[') ? JSON.parse(t) : t.startsWith('{') && !t.includes('\n{') ? [JSON.parse(t)] : readJSONL(f); };
const writeOnce = (f, text) => fs.writeFileSync(f, text, { mode: 0o400, flag: 'wx' });
const append = (f, row) => fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n', { mode: 0o600 });

function packets(exportDir) {
  const dir = path.join(exportDir, 'packets');
  return Object.fromEntries(fs.readdirSync(dir).sort().map(f => { const p = readJSON(path.join(dir, f)); return [p.packet_id, p]; }));
}

/** The numbered sources of a packet. @param {any} p */
function sourcesOf(p) {
  if (Array.isArray(p.discussion) && p.discussion.length) return p.discussion.map((d, i) => ({ position: i + 1, actor: d.label, text: d.text }));
  return [{ position: 1, actor: 'Answer', text: p.answer || '' }];
}
/** Texts the final answer may be quoted from. @param {any} p */
const answerTexts = (p) => [p.answer || '', ...(p.dialogue || []).filter(d => d.actor === 'Candidate').map(d => d.text)];
const solo = (p) => !(Array.isArray(p.discussion) && p.discussion.length);

function frozen(exportDir) {
  const f = path.join(dirOf(exportDir), 'frozen.json');
  return fs.existsSync(f) ? readJSON(f) : { codebook: null, inventory: null, coders: {} };
}
function saveFrozen(exportDir, x) {
  const f = path.join(dirOf(exportDir), 'frozen.json');
  fs.writeFileSync(f + '.tmp', JSON.stringify(x, null, 2), { mode: 0o600 });
  fs.renameSync(f + '.tmp', f);
}
/** Checks that a frozen file still has the bytes it was frozen with. */
function check(file, want) {
  const got = sha256(fs.readFileSync(file, 'utf8'));
  if (got !== want) throw new Error(`${path.basename(file)} changed after it was frozen (sha256 ${got.slice(0, 12)}, frozen ${want.slice(0, 12)}); stop and find out why`);
}

/**
 * Validates and freezes the shared inventory (and the codebook with it).
 * @param {string} exportDir @param {string} file @param {{ by: string, codebook?: any }} o
 */
function freezeInventory(exportDir, file, o) {
  const fz = frozen(exportDir);
  if (fz.inventory) throw new Error(`the inventory is already frozen (sha256 ${fz.inventory.sha256.slice(0, 12)}); it never changes. Record missing items as suggestions.`);
  const codebook = o.codebook || DEFAULT_CODEBOOK;
  if (!codebook.version || !codebook.fields) throw new Error('codebook: needs a version and fields');
  const ps = packets(exportDir);
  const errs = [];
  const ids = new Set();
  const entries = readAny(file);
  const seenPackets = new Set();
  for (const [i, e] of entries.entries()) {
    const at = `entry ${i + 1}`;
    const p = e && ps[e.packet_id];
    if (!p) { errs.push(`${at}: no packet "${e && e.packet_id}" in this export`); continue; }
    if (seenPackets.has(e.packet_id)) errs.push(`${at}: packet ${e.packet_id} appears twice`);
    seenPackets.add(e.packet_id);
    const srcs = sourcesOf(p);
    for (const [j, x] of (Array.isArray(e.propositions) ? e.propositions : []).entries()) {
      const where = `${e.packet_id} proposition ${j + 1}`;
      if (typeof x.id !== 'string' || !x.id.trim()) { errs.push(`${where}: id required`); continue; }
      if (ids.has(x.id)) errs.push(`${where}: id ${x.id} appears twice`);
      ids.add(x.id);
      if (typeof x.description !== 'string' || !x.description.trim()) errs.push(`${x.id}: description required`);
      if (!Array.isArray(x.source_positions) || !x.source_positions.length) errs.push(`${x.id}: source_positions required`);
      for (const pos of x.source_positions || []) if (!srcs.find(s => s.position === pos)) errs.push(`${x.id}: source position ${pos} does not exist (this packet has ${srcs.length})`);
      for (const s of x.sources || []) {
        const src = srcs.find(z => z.position === s.position);
        if (!src) { errs.push(`${x.id}: source position ${s.position} does not exist`); continue; }
        if (!(x.source_positions || []).includes(s.position)) errs.push(`${x.id}: quote from position ${s.position}, which is not in source_positions`);
        if (typeof s.quote !== 'string' || !s.quote || !src.text.includes(s.quote)) errs.push(`${x.id}: quote "${String(s.quote).slice(0, 40)}" is not in source ${s.position}`);
        if (s.char_start != null || s.char_end != null) {
          if (src.text.slice(s.char_start, s.char_end) !== s.quote) errs.push(`${x.id}: offsets ${s.char_start}-${s.char_end} do not give the quote in source ${s.position}`);
        }
      }
      if (x.excluded !== undefined && (typeof x.excluded !== 'string' || !x.excluded.trim())) errs.push(`${x.id}: excluded must say why`);
    }
  }
  if (!ids.size) errs.push('the inventory has no propositions');
  if (errs.length) throw new Error('inventory is not valid:\n- ' + errs.join('\n- '));
  const dir = dirOf(exportDir);
  fs.mkdirSync(path.join(dir, 'coders'), { recursive: true, mode: 0o700 });
  const invText = JSON.stringify(entries, null, 2) + '\n';
  const cbText = JSON.stringify(codebook, null, 2) + '\n';
  writeOnce(path.join(dir, 'inventory.json'), invText);
  writeOnce(path.join(dir, 'codebook.json'), cbText);
  const at = new Date().toISOString();
  saveFrozen(exportDir, { ...fz, codebook: { sha256: sha256(cbText), version: codebook.version, at },
    inventory: { sha256: sha256(invText), at, by: o.by, propositions: ids.size, packets: seenPackets.size,
      packets_without_propositions: Object.keys(ps).filter(id => !seenPackets.has(id)) } });
  return { propositions: ids.size, packets: seenPackets.size, sha256: sha256(invText) };
}

function loadFrozenInventory(exportDir) {
  const fz = frozen(exportDir);
  if (!fz.inventory) throw new Error('freeze the inventory first (node runner.js props-freeze)');
  const dir = dirOf(exportDir);
  check(path.join(dir, 'inventory.json'), fz.inventory.sha256);
  check(path.join(dir, 'codebook.json'), fz.codebook.sha256);
  const inventory = readJSON(path.join(dir, 'inventory.json'));
  const codebook = readJSON(path.join(dir, 'codebook.json'));
  const items = {};
  for (const e of inventory) for (const x of e.propositions) items[x.id] = { ...x, packet_id: e.packet_id };
  return { fz, inventory, codebook, items };
}

/**
 * A folder for one coder: the packets, the frozen inventory and codebook.
 * Never the key, ratings, or another coder's labels.
 * @param {string} exportDir @param {string} out
 */
function codingKit(exportDir, out) {
  loadFrozenInventory(exportDir);
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`${out} is not empty`);
  fs.mkdirSync(path.join(out, 'packets'), { recursive: true, mode: 0o700 });
  for (const f of fs.readdirSync(path.join(exportDir, 'packets'))) fs.copyFileSync(path.join(exportDir, 'packets', f), path.join(out, 'packets', f));
  for (const f of ['inventory.json', 'codebook.json']) fs.copyFileSync(path.join(dirOf(exportDir), f), path.join(out, f));
  fs.writeFileSync(path.join(out, 'README.md'), [
    '# Coding kit', '',
    'Code every proposition in inventory.json exactly once, one JSON object per line:',
    '`{"packet_id", "item_id", <each codebook field>, "source_quote", "answer_quote", "rationale"}`.',
    'Quotes must be copied exactly from the packet. Optional: "evidence" [{ "quote", "turn" }], "hint_note", "completion_note".',
    'Do not add items: write missing ones to a separate suggestions file. Do not look at another coder\'s labels.', '',
  ].join('\n'), { mode: 0o600 });
  return { out };
}

/**
 * Validates one coder's rows against the frozen inventory and freezes them.
 * @param {string} exportDir @param {string} coder @param {string} file @param {{ suggestions?: string }} [o]
 */
function importCoding(exportDir, coder, file, o = {}) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(coder)) throw new Error('coder: lower-case letters, digits, . _ -');
  const { fz, codebook, items } = loadFrozenInventory(exportDir);
  if (fz.coders[coder]) throw new Error(`coder ${coder} is already frozen; a frozen coding never changes`);
  const ps = packets(exportDir);
  const rows = readAny(file);
  const errs = [];
  const done = new Set();
  for (const [i, r] of rows.entries()) {
    const at = `row ${i + 1}`;
    const it = r && items[r.item_id];
    if (!it) { errs.push(`${at}: item "${r && r.item_id}" is not in the inventory`); continue; }
    if (r.packet_id !== it.packet_id) errs.push(`${r.item_id}: packet_id is ${r.packet_id}, the inventory says ${it.packet_id}`);
    if (done.has(r.item_id)) errs.push(`${r.item_id}: coded twice`);
    done.add(r.item_id);
    const p = ps[it.packet_id];
    for (const [f, allowed] of Object.entries(codebook.fields)) {
      if (!allowed.includes(r[f])) errs.push(`${r.item_id}: ${f} must be one of ${allowed.join(', ')}`);
    }
    if (codebook.solo_field && codebook.fields[codebook.solo_field]) {
      const isSolo = solo(p);
      if (isSolo && r[codebook.solo_field] !== codebook.solo_value) errs.push(`${r.item_id}: a solo packet has ${codebook.solo_field} ${codebook.solo_value}`);
      if (!isSolo && r[codebook.solo_field] === codebook.solo_value) errs.push(`${r.item_id}: ${codebook.solo_value} is for solo packets only`);
    }
    for (const f of codebook.text_fields || []) if (typeof r[f] !== 'string') errs.push(`${r.item_id}: ${f} must be text (empty if there is none)`);
    const srcText = sourcesOf(p).filter(s => (it.source_positions || []).includes(s.position)).map(s => s.text);
    if (r.source_quote && !srcText.some(t => t.includes(r.source_quote))) errs.push(`${r.item_id}: source_quote is not in the item's sources`);
    if (r.answer_quote && !answerTexts(p).some(t => t.includes(r.answer_quote))) errs.push(`${r.item_id}: answer_quote is not in the answer`);
    for (const ev of r.evidence || []) {
      const msg = (p.dialogue || []).find(d => d.n === ev.turn);
      if (!msg || typeof ev.quote !== 'string' || !msg.text.includes(ev.quote)) errs.push(`${r.item_id}: evidence quote is not in dialogue message ${ev.turn}`);
    }
  }
  const missing = Object.entries(items).filter(([id, x]) => !x.excluded && !done.has(id)).map(([id]) => id);
  if (missing.length) errs.push(`not coded: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` and ${missing.length - 10} more` : ''} (every item, exactly once)`);
  const coded_excluded = [...done].filter(id => items[id] && items[id].excluded);
  if (coded_excluded.length) errs.push(`excluded in the inventory, so not coded: ${coded_excluded.join(', ')}`);
  if (errs.length) throw new Error(`coding by ${coder} is not valid:\n- ` + errs.join('\n- '));
  const dir = path.join(dirOf(exportDir), 'coders');
  const text = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  writeOnce(path.join(dir, `${coder}.jsonl`), text);
  let sug = null;
  if (o.suggestions) {
    const s = readAny(o.suggestions);
    const st = s.map(r => JSON.stringify(r)).join('\n') + '\n';
    writeOnce(path.join(dir, `${coder}.suggestions.jsonl`), st);
    sug = { sha256: sha256(st), n: s.length };
  }
  fz.coders[coder] = { sha256: sha256(text), at: new Date().toISOString(), rows: rows.length, suggestions: sug };
  saveFrozen(exportDir, fz);
  return { rows: rows.length };
}

function loadCodings(exportDir) {
  const inv = loadFrozenInventory(exportDir);
  const coders = Object.keys(inv.fz.coders).sort();
  if (coders.length < 2) throw new Error(`two frozen codings are needed; frozen so far: ${coders.join(', ') || 'none'}`);
  const dir = path.join(dirOf(exportDir), 'coders');
  const by = {};
  for (const c of coders) {
    check(path.join(dir, `${c}.jsonl`), inv.fz.coders[c].sha256);
    by[c] = Object.fromEntries(readJSONL(path.join(dir, `${c}.jsonl`)).map(r => [r.item_id, r]));
  }
  return { ...inv, coders: coders.slice(0, 2), by };
}

/** Cohen's kappa, or null where it does not mean anything (one category only). */
function kappa(pairs, cats) {
  const n = pairs.length;
  if (!n) return null;
  const po = pairs.filter(([a, b]) => a === b).length / n;
  const pe = cats.reduce((s, c) => s + (pairs.filter(([a]) => a === c).length / n) * (pairs.filter(([, b]) => b === c).length / n), 0);
  return pe >= 1 ? null : Math.round((po - pe) / (1 - pe) * 1000) / 1000;
}

/**
 * Agreement between the two frozen codings, field by field. Writes agreement.json.
 * @param {string} exportDir
 */
function agreement(exportDir) {
  const { coders: [a, b], by, items, codebook, fz } = loadCodings(exportDir);
  const ps = packets(exportDir);
  const ids = Object.keys(items).filter(id => !items[id].excluded).sort();
  const fields = {};
  for (const [f, cats] of Object.entries(codebook.fields)) {
    const pairs = ids.map(id => [by[a][id][f], by[b][id][f]]);
    const confusion = Object.fromEntries(cats.map(x => [x, Object.fromEntries(cats.map(y => [y, pairs.filter(([p, q]) => p === x && q === y).length]))]));
    const prevalence = Object.fromEntries(cats.map(c => [c, { [a]: pairs.filter(([p]) => p === c).length, [b]: pairs.filter(([, q]) => q === c).length }]));
    const agree = pairs.filter(([p, q]) => p === q).length;
    fields[f] = { n: pairs.length, agree, raw: pairs.length ? Math.round(agree / pairs.length * 1000) / 1000 : null, kappa: kappa(pairs, cats),
      confusion, prevalence, differ: ids.filter(id => by[a][id][f] !== by[b][id][f]) };
  }
  const perCase = {};
  for (const id of ids) {
    const c = ps[items[id].packet_id].case;
    const cell = (perCase[c] ||= { items: 0, agree: Object.fromEntries(Object.keys(codebook.fields).map(f => [f, 0])) });
    cell.items++;
    for (const f of Object.keys(codebook.fields)) if (by[a][id][f] === by[b][id][f]) cell.agree[f]++;
  }
  const result = { coders: [a, b], codebook: codebook.version, inventory_sha256: fz.inventory.sha256, coding_sha256: { [a]: fz.coders[a].sha256, [b]: fz.coders[b].sha256 },
    items: ids.length, exclusions: Object.values(items).filter(x => x.excluded).map(x => ({ id: x.id, why: x.excluded })), per_case: perCase, fields,
    note: 'Kappa is left out (null) where a field has one category only. Small samples and propositions clustered in packets limit what these numbers mean.' };
  fs.writeFileSync(path.join(dirOf(exportDir), 'agreement.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  return result;
}

/**
 * A person's resolution of one difference. The coders' rows stay as they are.
 * @param {string} exportDir @param {{ item_id: string, field: string, value: string, by: string, rationale: string, evidence?: string }} r
 */
function adjudicateProposition(exportDir, r) {
  const { codebook, items, coders: [a, b], by } = loadCodings(exportDir);
  if (!items[r.item_id]) throw new Error(`no item ${r.item_id}`);
  const allowed = codebook.fields[r.field];
  if (!allowed) throw new Error(`field: one of ${Object.keys(codebook.fields).join(', ')}`);
  if (!allowed.includes(r.value)) throw new Error(`${r.field}: one of ${allowed.join(', ')}`);
  if (!r.rationale || !r.rationale.trim()) throw new Error('rationale: required');
  append(path.join(dirOf(exportDir), 'adjudications.jsonl'), { item_id: r.item_id, field: r.field,
    original: { [a]: by[a][r.item_id][r.field], [b]: by[b][r.item_id][r.field] }, resolution: r.value, by: r.by, rationale: r.rationale, evidence: r.evidence || '' });
}

/** Each item and field: both ratings and the final value (agreed, adjudicated, or open). @param {string} exportDir */
function resolved(exportDir) {
  const { coders: [a, b], by, items, codebook } = loadCodings(exportDir);
  const f = path.join(dirOf(exportDir), 'adjudications.jsonl');
  const adj = fs.existsSync(f) ? readJSONL(f) : [];
  const rows = [];
  for (const id of Object.keys(items).filter(x => !items[x].excluded).sort()) {
    for (const field of Object.keys(codebook.fields)) {
      const va = by[a][id][field], vb = by[b][id][field];
      const settled = adj.filter(x => x.item_id === id && x.field === field).pop();
      rows.push({ item_id: id, packet_id: items[id].packet_id, field, [a]: va, [b]: vb, final: va === vb ? va : settled ? settled.resolution : null, how: va === vb ? 'agreed' : settled ? 'adjudicated' : 'open' });
    }
  }
  return rows;
}

/**
 * Counts per condition, only once both codings are frozen, agreement is
 * written and every difference is adjudicated.
 * @param {string} exportDir @param {string} keyFile
 */
function unblindPropositions(exportDir, keyFile) {
  if (!fs.existsSync(path.join(dirOf(exportDir), 'agreement.json'))) throw new Error('compute agreement first (node runner.js props-agreement)');
  const rows = resolved(exportDir);
  const open = rows.filter(r => r.how === 'open');
  if (open.length) throw new Error(`${open.length} difference(s) not adjudicated yet, e.g. ${open.slice(0, 3).map(r => `${r.item_id} ${r.field}`).join(', ')}; the key stays closed`);
  const key = readJSON(keyFile);
  const out = {};
  for (const r of rows) {
    const k = key.packets.find(p => p.packet_id === r.packet_id);
    const c = (out[k.condition] ||= { packets: new Set(), fields: {} });
    c.packets.add(r.packet_id);
    const cell = (c.fields[r.field] ||= {});
    cell[r.final] = (cell[r.final] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).map(([c, x]) => [c, { packets: x.packets.size, fields: x.fields }]));
}

module.exports = { DEFAULT_CODEBOOK, sourcesOf, freezeInventory, codingKit, importCoding, agreement, adjudicateProposition, resolved, unblindPropositions, kappa };
