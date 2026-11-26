// @ts-check
// runner/export.js, runner/judging.js, runner/report.js: blinded packets and
// their key, judges and people rating them, and the run report. Fake provider only.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runStudy } = require('../runner/run');
const { fakeProvider } = require('../runner/providers');
const { exportPackets, leaks, labelsOf } = require('../runner/export');
const { judgePackets, summarize, addHumanRating, adjudicate } = require('../runner/judging');
const { writeReport } = require('../runner/report');
const { shuffled } = require('../runner/view');

const ROOT = path.join(__dirname, '..');
const sample = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'runner', 'sample-fake.json'), 'utf8'));
const markerOf = (req) => (/starts with "([^"]+)" followed by your final answer/.exec(req.messages.map(m => m.content).join('\n')) || [])[1];
const prompt = (req) => req.messages.map(m => m.content).join('\n');

// Participants name themselves and their maker in their text, as models do.
const chatty = (req) => markerOf(req)
  ? { text: `As fake:${req.model} (made by Anthropic, a Claude model) I conclude.\n${markerOf(req)} Lower prices.` }
  : { text: `${req.model} here, an OpenAI GPT model: prices rose 15%.` };

async function runSample(script = chatty, edit = (s) => s) {
  const study = edit(sample());
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-eval-')), 'run');
  const fake = fakeProvider(script);
  await runStudy({ study, out, adapters: { fake: fake.adapter }, sleep: async () => {} });
  return { study, out, fake };
}

test('the sample study: same participant-facing task and the same final-answer rule in every condition', async () => {
  const { study, fake } = await runSample();
  for (const kase of study.cases) {
    const asked = fake.seen.filter(r => prompt(r).includes(kase.task));
    // solo expert, 2 + 2 experts, 2 moderators: 7 prompts carry this case's task word for word.
    expect(asked).toHaveLength(7);
    const closing = asked.filter(markerOf).map(r => r.messages[1].content.split('\n').pop());
    expect(closing).toHaveLength(3);
    expect(new Set(closing).size).toBe(1);
    expect(closing[0]).toContain('"FINAL RECOMMENDATION:"');
  }
});

test('a blinded export has no condition or model labels in fields, values or filenames; the key is kept apart', async () => {
  const { study, out } = await runSample();
  const x = exportPackets({ run: out, sees: ['answer', 'discussion', 'source'] });
  expect(x.leaks).toEqual([]);
  expect(path.dirname(x.keyFile)).not.toBe(x.packetsDir);
  expect(x.keyFile.startsWith(x.dir + path.sep)).toBe(false);
  const files = fs.readdirSync(x.packetsDir);
  expect(files).toHaveLength(6);
  const all = files.map(f => fs.readFileSync(path.join(x.packetsDir, f), 'utf8')).join('\n');
  for (const word of ['fake:alpha', 'fake:beta', 'alpha', 'beta', 'Anthropic', 'Claude', 'OpenAI', 'GPT', '"same-family"', '"mixed"', '"solo"', 'experts_moderator']) expect(all).not.toContain(word);
  expect(all).toContain('[model]');
  const p = JSON.parse(fs.readFileSync(path.join(x.packetsDir, files[0]), 'utf8'));
  expect(Object.keys(p).sort()).toEqual(['answer', 'case', 'discussion', 'materials', 'packet_id', 'reference', 'shown', 'status', 'task']);
  expect(p.shown).toEqual({ source: true, answer: true, discussion: true, dialogue: false });
  // The key says which packet is which, and how many labels were taken out.
  const key = JSON.parse(fs.readFileSync(x.keyFile, 'utf8'));
  expect(key.packets.map(k => k.condition).sort()).toEqual(['mixed', 'mixed', 'same-family', 'same-family', 'solo', 'solo']);
  expect(key.packets.every(k => k.labels_removed > 0)).toBe(true);
  const manifest = JSON.parse(fs.readFileSync(path.join(x.dir, 'manifest.json'), 'utf8'));
  expect(manifest.residual_leakage.join(' ')).toContain('A packet with a discussion comes from a team condition');
  // The order is the seeded shuffle of the sessions (it can match session order by chance, 1 in 720).
  const sessions = Object.keys(JSON.parse(fs.readFileSync(path.join(out, 'state.json'), 'utf8')).sessions);
  expect(key.packets.map(k => k.key)).toEqual(shuffled(sessions.map((_, i) => i), `${study.seed ?? 0}:${x.export_id}`).map(i => sessions[i]));
});

test('the leak check catches a planted label in a field, a value and a filename', async () => {
  const { study, out } = await runSample();
  const x = exportPackets({ run: out });
  fs.writeFileSync(path.join(x.packetsDir, 'p_alpha-mixed.json'), JSON.stringify({ packet_id: 'p', condition: 'mixed', answer: 'by fake:beta' }));
  const found = leaks(x.packetsDir, labelsOf(study));
  expect(found.join('\n')).toMatch(/filename p_alpha-mixed\.json/);
  expect(found.join('\n')).toMatch(/field \$\.condition/);
  expect(found.join('\n')).toMatch(/names "fake:beta"/);
});

test('judges: never their own family; four dimensions; raw ratings, disagreement for a person, adjudication, then unblinded means with n', async () => {
  const { out } = await runSample();
  const x = exportPackets({ run: out, sees: ['answer', 'discussion'] });
  const dims = ['perspective_coverage', 'factual_support', 'decision_quality', 'information_transfer'];
  const judgeScript = (req) => {
    const p = prompt(req);
    const these = dims.filter(d => p.includes(`- ${d}:`));
    const s = req.model === 'gamma' ? 8 : 3;
    return { text: JSON.stringify({ scores: Object.fromEntries(these.map(d => [d, s])), rationale: Object.fromEntries(these.map(d => [d, `because ${d}`])) }) };
  };
  const judges = fakeProvider(judgeScript);
  const r = await judgePackets({ exportDir: x.dir, keyFile: x.keyFile, judges: ['fake:alpha', 'fake:gamma', 'fake:delta'], adapters: { fake: judges.adapter }, prices: {}, run_usd: 1, sleep: async () => {} });
  // fake:alpha took part in every session: it judges nothing.
  expect(r.skipped).toHaveLength(6);
  expect(r.skipped.every(s => s.judge === 'fake:alpha')).toBe(true);
  expect(judges.seen.every(q => q.model !== 'alpha')).toBe(true);
  // Judges saw the packet, never the key.
  for (const q of judges.seen) { expect(prompt(q)).not.toContain('same-family'); expect(prompt(q)).not.toContain('packet_id'); }
  const ratings = fs.readFileSync(path.join(x.dir, 'ratings.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const solo = JSON.parse(fs.readFileSync(x.keyFile, 'utf8')).packets.filter(k => k.condition === 'solo').map(k => k.packet_id);
  // Solo packets have no discussion: three dimensions; team packets four. Two judges each.
  expect(ratings).toHaveLength(2 * (2 * 3 + 4 * 4));
  expect(ratings.filter(q => solo.includes(q.packet_id)).every(q => q.dimension !== 'information_transfer')).toBe(true);
  expect(ratings[0]).toMatchObject({ rater: { kind: 'model' }, saw: { answer: true, discussion: true, source: false } });
  expect(ratings[0].rationale).toMatch(/^because /);

  // 8 vs 3 everywhere: every row goes to a person.
  let s = summarize(x.dir);
  expect(s.rows.every(q => q.spread === 5 && q.for_person === 'raters disagree by more than 2')).toBe(true);
  const one = s.rows[0];
  adjudicate(x.dir, { packet_id: one.packet_id, dimension: one.dimension, score: 6, by: 'researcher', note: 'read both rationales' });
  addHumanRating(x.dir, { packet_id: one.packet_id, dimension: one.dimension, score: 7, rationale: 'clear', by: 'researcher' });
  expect(() => addHumanRating(x.dir, { packet_id: one.packet_id, dimension: one.dimension, score: 11, rationale: '', by: 'r' })).toThrow(/1 to 10/);
  s = summarize(x.dir, { keyFile: x.keyFile });
  const settled = s.rows.find(q => q.packet_id === one.packet_id && q.dimension === one.dimension);
  expect(settled).toMatchObject({ adjudicated: 6, for_person: null, scores: [8, 3, 7] });
  expect(s.byCondition.solo.decision_quality.n).toBe(2);
  expect(s.byCondition.solo.information_transfer).toBeUndefined();
  // A second judge run does not score twice.
  const again = fakeProvider(judgeScript);
  await judgePackets({ exportDir: x.dir, keyFile: x.keyFile, judges: ['fake:gamma', 'fake:delta'], adapters: { fake: again.adapter }, prices: {}, run_usd: 1 });
  expect(again.seen).toHaveLength(0);
});

test('the report lists every session with status, models, cost and evidence, and says it proves no effect', async () => {
  // The clinic moderator never closes: those sessions end at the turn limit.
  const stubborn = (req) => markerOf(req) && prompt(req).includes('Monday') && req.messages[0].content.includes('lead the discussion')
    ? { text: 'Still thinking.' } : chatty(req);
  const { out } = await runSample(stubborn, (s) => { s.limits.turns = 2; return s; });
  const text = writeReport(out);
  expect(text).toContain('does not show that any condition works better');
  expect(text).toContain('At most 2 session(s) per condition: far too few');
  expect(text).toContain('| solo | 2 | 2 | 0 | 0 | 0 |');
  expect(text).toContain('| mixed | 2 | 1 | 0 | 1 | 0 |');
  expect(text).toContain('| same-family | 2 | 1 | 0 | 1 | 0 |');
  expect(text).toMatch(/\| clinic--mixed--r1 \| incomplete \| turn_limit \| Expert 1: fake:alpha, Expert 2: fake:beta, Moderator: fake:alpha \| \d+ \| 1 \| \$0\.\d{4} \(\$0\.0000\) \| sessions\/clinic--mixed--r1\/ses_[0-9a-f]+\/ \|/);
  expect(text).toContain('Models that answered: fake:alpha -> fake-alpha; fake:beta -> fake-beta');
  expect(text).toContain('fake:alpha $1/$5 per M tokens (as of 2026-11-26)');
  expect(fs.readFileSync(path.join(out, 'report.md'), 'utf8')).toBe(text);
});

test('the CLI goes from a run to a report, an export and a summary of ratings', async () => {
  const { out } = await runSample();
  const node = (...a) => execFileSync('node', [path.join(ROOT, 'runner.js'), ...a], { encoding: 'utf8' });
  expect(node('report', out)).toContain('report.md');
  const said = node('export', out, '--sees', 'answer');
  const dir = /Packets: (.+)\/packets/.exec(said)[1];
  const packet = fs.readdirSync(path.join(dir, 'packets'))[0].replace('.json', '');
  node('rate', dir, packet, 'decision_quality', '7', 'specific and sound', '--by', 'researcher');
  const summary = node('ratings', dir);
  expect(summary).toContain(`${packet} decision_quality: 7`);
  expect(summary).toContain('for a person: fewer than 2 raters');
  expect(node('ratings', dir, '--unblind')).toContain('do not read these as effects');
});
