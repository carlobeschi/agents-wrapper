// @ts-check
// runner/propositions.js: a frozen shared inventory, two independent coders,
// agreement, adjudication, and the key opened last. Fake provider only.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runStudy } = require('../runner/run');
const { fakeProvider } = require('../runner/providers');
const { exportPackets } = require('../runner/export');
const P = require('../runner/propositions');

const ROOT = path.join(__dirname, '..');
const markerOf = (req) => (/starts with "([^"]+)" followed by your final answer/.exec(req.messages.map(m => m.content).join('\n')) || [])[1];
const script = (req) => markerOf(req)
  ? { text: `Prices rose 15% and we weigh both views. Test one change first.\n${markerOf(req)} Lower prices for a month and measure.` }
  : { text: `Prices rose 15% and the cafe opened. Test one change first. (${req.model})` };

async function setup() {
  const study = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'runner', 'sample-fake.json'), 'utf8'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-props-'));
  const out = path.join(tmp, 'run');
  await runStudy({ study, out, adapters: { fake: fakeProvider(script).adapter }, sleep: async () => {} });
  const x = exportPackets({ run: out, sees: ['answer', 'discussion'] });
  const packets = fs.readdirSync(x.packetsDir).map(f => JSON.parse(fs.readFileSync(path.join(x.packetsDir, f), 'utf8')));
  // Two propositions per packet, quoted from source 1.
  const inventory = packets.map(p => {
    const src = P.sourcesOf(p)[0].text;
    const at = src.indexOf('Test one change first.');
    return { packet_id: p.packet_id, propositions: [
      { id: `${p.packet_id}-P001`, description: 'Prices rose.', source_positions: [1], sources: [{ position: 1, quote: 'Prices rose 15%' }] },
      { id: `${p.packet_id}-P002`, description: 'Test one change first.', source_positions: [1], sources: [{ position: 1, quote: 'Test one change first.', char_start: at, char_end: at + 22 }] },
    ] };
  });
  const invFile = path.join(tmp, 'inventory.json');
  fs.writeFileSync(invFile, JSON.stringify(inventory));
  return { tmp, out, x, packets, inventory, invFile };
}

/** A coder's rows: every item, solo packets not_applicable; `vary` changes some values. */
function rows(packets, inventory, vary = (r) => r) {
  return inventory.flatMap(e => e.propositions.map(it => {
    const p = packets.find(q => q.packet_id === e.packet_id);
    const isSolo = !(p.discussion && p.discussion.length);
    return vary({ packet_id: e.packet_id, item_id: it.id, source_presence: 'present', moderator_treatment: isSolo ? 'not_applicable' : 'included',
      visible_support: 'supported', reference_support: 'not_assessable', source_quote: it.sources[0].quote, answer_quote: 'Lower prices', rationale: 'both say so' }, it, isSolo);
  }));
}
const write = (dir, name, rs) => { const f = path.join(dir, name); fs.writeFileSync(f, rs.map(r => JSON.stringify(r)).join('\n')); return f; };

test('the inventory is checked against the exact packet text, then frozen: its bytes never change', async () => {
  const { x, tmp, inventory, invFile } = await setup();
  const bad = JSON.parse(JSON.stringify(inventory));
  bad[0].propositions[0].sources[0].quote = 'not in the text';
  bad[0].propositions[1].sources[0].char_start += 1;
  bad[1].propositions[1].id = bad[1].propositions[0].id;
  bad[2].propositions[0].source_positions = [9];
  const badFile = path.join(tmp, 'bad.json');
  fs.writeFileSync(badFile, JSON.stringify(bad));
  let msg = '';
  try { P.freezeInventory(x.dir, badFile, { by: 'extractor' }); } catch (e) { msg = e.message; }
  expect(msg).toMatch(/quote "not in the text" is not in source 1/);
  expect(msg).toMatch(/offsets .* do not give the quote/);
  expect(msg).toMatch(/appears twice/);
  expect(msg).toMatch(/source position 9 does not exist/);
  const r = P.freezeInventory(x.dir, invFile, { by: 'extractor' });
  expect(r).toMatchObject({ propositions: 12, packets: 6 });
  expect(() => P.freezeInventory(x.dir, invFile, { by: 'extractor' })).toThrow(/already frozen/);
  const fz = JSON.parse(fs.readFileSync(path.join(x.dir, 'propositions', 'frozen.json'), 'utf8'));
  expect(fz.codebook.version).toBe(P.DEFAULT_CODEBOOK.version);
  expect(fz.inventory.by).toBe('extractor');
  // A changed inventory is caught.
  const inv = path.join(x.dir, 'propositions', 'inventory.json');
  fs.chmodSync(inv, 0o600);
  fs.appendFileSync(inv, ' ');
  expect(() => P.codingKit(x.dir, path.join(tmp, 'kit'))).toThrow(/changed after it was frozen/);
});

test('a coding kit has packets, inventory and codebook only; a coding must cover every item once, with allowed values and exact quotes', async () => {
  const { x, tmp, packets, inventory, invFile } = await setup();
  P.freezeInventory(x.dir, invFile, { by: 'extractor' });
  const kit = path.join(tmp, 'kit');
  P.codingKit(x.dir, kit);
  expect(fs.readdirSync(kit).sort()).toEqual(['README.md', 'codebook.json', 'inventory.json', 'packets']);
  const all = fs.readdirSync(path.join(kit, 'packets')).map(f => fs.readFileSync(path.join(kit, 'packets', f), 'utf8')).join('');
  expect(all).not.toMatch(/same-family|"mixed"|"solo"/);
  const good = rows(packets, inventory);
  const broken = good.slice(1).map((r, i) => i === 0 ? { ...r, visible_support: 'true' } : i === 1 ? { ...r, source_quote: 'invented' } : i === 2 ? { ...r, moderator_treatment: r.moderator_treatment === 'not_applicable' ? 'included' : 'not_applicable' } : r);
  let msg = '';
  try { P.importCoding(x.dir, 'coder-a', write(tmp, 'broken.jsonl', broken)); } catch (e) { msg = e.message; }
  expect(msg).toMatch(/not coded: /);
  expect(msg).toMatch(/visible_support must be one of supported, contradicted, unsupported_unknown, not_assessable/);
  expect(msg).toMatch(/source_quote is not in the item's sources/);
  expect(msg).toMatch(/solo packet|for solo packets only/);
  expect(P.importCoding(x.dir, 'coder-a', write(tmp, 'a.jsonl', good), { suggestions: write(tmp, 'sug.jsonl', [{ packet_id: packets[0].packet_id, description: 'the cafe' }]) })).toEqual({ rows: 12 });
  expect(() => P.importCoding(x.dir, 'coder-a', write(tmp, 'a2.jsonl', good))).toThrow(/already frozen/);
  // With one coding only there is no agreement yet.
  expect(() => P.agreement(x.dir)).toThrow(/two frozen codings are needed/);
});

test('agreement per field with confusion and prevalence; kappa only where it means something; the key opens only after every difference is adjudicated', async () => {
  const { x, tmp, packets, inventory, invFile } = await setup();
  P.freezeInventory(x.dir, invFile, { by: 'extractor' });
  P.importCoding(x.dir, 'coder-a', write(tmp, 'a.jsonl', rows(packets, inventory)));
  // Coder b differs on visible_support for every second proposition.
  const b = rows(packets, inventory, (r, it) => it.id.endsWith('P002') ? { ...r, visible_support: 'unsupported_unknown' } : r);
  P.importCoding(x.dir, 'coder-b', write(tmp, 'b.jsonl', b));
  const before = fs.readFileSync(path.join(x.dir, 'propositions', 'coders', 'coder-a.jsonl'), 'utf8');
  const g = P.agreement(x.dir);
  expect(g.items).toBe(12);
  expect(g.fields.visible_support).toMatchObject({ n: 12, agree: 6, raw: 0.5 });
  expect(g.fields.visible_support.confusion.supported.unsupported_unknown).toBe(6);
  expect(g.fields.visible_support.prevalence.supported).toEqual({ 'coder-a': 12, 'coder-b': 6 });
  // Every rater used one category only: kappa is not computed.
  expect(g.fields.source_presence.kappa).toBeNull();
  expect(g.fields.source_presence.raw).toBe(1);
  expect(Object.values(g.per_case).reduce((s, c) => s + c.items, 0)).toBe(12);
  expect(() => P.unblindPropositions(x.dir, x.keyFile)).toThrow(/6 difference\(s\) not adjudicated yet/);
  expect(() => P.adjudicateProposition(x.dir, { item_id: g.fields.visible_support.differ[0], field: 'visible_support', value: 'maybe', by: 'r', rationale: 'x' })).toThrow(/one of/);
  for (const id of g.fields.visible_support.differ) {
    P.adjudicateProposition(x.dir, { item_id: id, field: 'visible_support', value: 'unsupported_unknown', by: 'researcher', rationale: 'a suggestion, not an established fact', evidence: 'Test one change first.' });
  }
  const adj = fs.readFileSync(path.join(x.dir, 'propositions', 'adjudications.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  expect(adj[0]).toMatchObject({ original: { 'coder-a': 'supported', 'coder-b': 'unsupported_unknown' }, resolution: 'unsupported_unknown', by: 'researcher' });
  const u = P.unblindPropositions(x.dir, x.keyFile);
  expect(Object.keys(u).sort()).toEqual(['mixed', 'same-family', 'solo']);
  expect(u.solo.fields.moderator_treatment).toEqual({ not_applicable: 4 });
  expect(u.mixed.fields.visible_support).toEqual({ supported: 2, unsupported_unknown: 2 });
  // Nothing overwrote a coder's rows.
  expect(fs.readFileSync(path.join(x.dir, 'propositions', 'coders', 'coder-a.jsonl'), 'utf8')).toBe(before);
});

test('the CLI: freeze, kit, two codings, agreement, adjudication, unblind', async () => {
  const { x, tmp, packets, inventory, invFile } = await setup();
  const node = (...a) => execFileSync('node', [path.join(ROOT, 'runner.js'), ...a], { encoding: 'utf8' });
  expect(node('props-freeze', x.dir, invFile, '--by', 'extractor')).toContain('Frozen: 12 proposition(s) in 6 packet(s)');
  expect(node('props-kit', x.dir, path.join(tmp, 'kit'))).toContain('no key');
  node('props-code', x.dir, 'coder-a', write(tmp, 'a.jsonl', rows(packets, inventory)));
  const one = inventory[0].propositions[0].id;
  node('props-code', x.dir, 'coder-b', write(tmp, 'b.jsonl', rows(packets, inventory, (r, it) => it.id === one ? { ...r, source_presence: 'partial' } : r)));
  expect(node('props-agreement', x.dir)).toContain('source_presence: 11/12 agree');
  expect(() => node('props-unblind', x.dir)).toThrow();
  node('props-adjudicate', x.dir, one, 'source_presence', 'present', 'the quote is the whole claim', '--by', 'researcher');
  expect(node('props-unblind', x.dir)).toContain('Similar wording is not evidence of cause');
});
