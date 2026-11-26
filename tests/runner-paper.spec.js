// @ts-check
// Interviews with paper_prompts (runner/enterprisebench-prompts.js): what each
// role is sent, JSON replies and their fallbacks, completion, the secret guard.
// Fake provider only.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runStudy } = require('../runner/run');
const { fakeProvider } = require('../runner/providers');
const { checkStudy } = require('../runner/study');
const { exportPackets } = require('../runner/export');

const ROOT = path.join(__dirname, '..');
const all = (req) => req.messages.map(m => m.content).join('\n');
const isInterviewer = (req) => all(req).includes('You are running a consulting case interview.');
const isExpert = (req) => /You are Expert #\d/.test(all(req));
const isModerator = (req) => all(req).includes('You are the MODERATOR');
const turnsLeft = (req) => Number((/Maximum remaining turns \(including this one\) is (\d+)/.exec(all(req)) || [])[1]);

function paperStudy(panel = false, edit = (c) => c) {
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'runner', 'sample-interview-fake.json'), 'utf8'));
  const c = { ...s.conditions[panel ? 1 : 0], paper_prompts: true, candidate_marker_instruction: false, hint_marker: null };
  s.conditions = [edit(c)];
  return s;
}

async function run(study, script) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-paper-')), 'run');
  const fake = fakeProvider(script);
  const r = await runStudy({ study, out, adapters: { fake: fake.adapter }, sleep: async () => {} });
  const key = Object.keys(r.state.sessions)[0];
  const dir = path.join(out, r.state.sessions[key].outcome.path);
  return { out, fake, o: JSON.parse(fs.readFileSync(path.join(dir, 'outcome.json'), 'utf8')), dir };
}

test('paper solo: the interviewer gets the secret as case text, the candidate only the dialogue in JSON; ended by the interviewer after a real reply, it is complete', async () => {
  const script = (req) => isInterviewer(req)
    ? { text: turnsLeft(req) === 12 ? 'A ferry operator loses money in winter. How would you structure this?' : 'Thanks. <|CASE_INTERVIEW_END|> Good work.' }
    : { text: '```json\n{"reply": "Cut the quiet crossings, keep the 06:00 freight."}\n```' };
  const { fake, o } = await run(paperStudy(), script);
  expect(o).toMatchObject({ status: 'complete', ended_by: 'interviewer_end', final: 'Cut the quiet crossings, keep the 06:00 freight.', fallbacks: 0, turns: 3 });
  const iv = fake.seen.filter(isInterviewer);
  expect(all(iv[0])).toContain('=== CASE TEXT (only you can see) ===\nReference: cut the four');
  expect(iv.map(turnsLeft)).toEqual([12, 10]);
  const cand = fake.seen.find(q => !isInterviewer(q));
  expect(cand.json_mode).toBe(true);
  expect(all(cand)).toContain('Current case ID: ferry');
  expect(all(cand)).not.toContain('Fuel is 40%');
  expect(all(cand)).not.toContain('Reference:');
  expect(all(cand)).not.toContain('FINAL RECOMMENDATION');
});

test('paper solo: a reply that is not JSON becomes the fixed fallback, marked and counted, and never an answer', async () => {
  const script = (req) => isInterviewer(req)
    ? { text: turnsLeft(req) === 12 ? 'Opening.' : 'Done. <|CASE_INTERVIEW_END|>' }
    : { text: 'I would start with occupancy.' };
  const { out, o, dir } = await run(paperStudy(), script);
  expect(o).toMatchObject({ status: 'incomplete', ended_by: 'interviewer_end', fallbacks: 1 });
  expect(o.dialogue[1]).toMatchObject({ actor: 'Candidate', fallback: true });
  expect(o.dialogue[1].text).toMatch(/^Let me first structure the key issues/);
  expect(fs.readFileSync(path.join(dir, 'dialogue.md'), 'utf8')).toContain('not the model\'s words');
  const events = fs.readFileSync(path.join(out, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  expect(events.filter(e => e.what === 'paper candidate fallback')).toHaveLength(1);
  const x = exportPackets({ run: out, sees: ['dialogue'] });
  const p = JSON.parse(fs.readFileSync(path.join(x.packetsDir, fs.readdirSync(x.packetsDir)[0]), 'utf8'));
  expect(p.dialogue[1].fallback).toBe(true);
});

test('paper panel: three experts one after another in a fixed order, no system prompt, JSON asked; the moderator\'s fenced JSON is read, plain text falls back to the whole reply', async () => {
  let modCalls = 0;
  const script = (req) => {
    if (isInterviewer(req)) return { text: turnsLeft(req) > 8 ? 'What do you look at?' : 'Thanks. <|CASE_INTERVIEW_END|>' };
    if (isExpert(req)) return { text: `{"reasoning": "occupancy", "final_answer": "expert ${/Expert #(\d)/.exec(all(req))[1]} says look at occupancy"}` };
    if (isModerator(req)) return { text: ++modCalls === 1 ? '```json\n{"reasoning": "agree", "final_answer": "Look at occupancy per crossing."}\n```' : 'Keep the two busy crossings.' };
    return { text: '' };
  };
  const { fake, o, out } = await run(paperStudy(true), script);
  const experts = fake.seen.filter(isExpert);
  expect(experts.map(q => /Expert #(\d)/.exec(all(q))[1])).toEqual(['1', '2', '3', '1', '2', '3']);
  expect(experts.every(q => q.messages.length === 1 && q.messages[0].role === 'user' && q.json_mode === true)).toBe(true);
  expect(experts.every(q => !all(q).includes('Fuel is 40%') && !all(q).includes('Reference:'))).toBe(true);
  expect(o.dialogue.filter(d => d.actor === 'Candidate').map(d => d.text)).toEqual(['Look at occupancy per crossing.', 'Keep the two busy crossings.']);
  expect(o).toMatchObject({ status: 'complete', final: 'Keep the two busy crossings.' });
  const events = fs.readFileSync(path.join(out, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  expect(events.filter(e => e.what === 'paper moderator raw fallback').map(e => e.output_type)).toEqual(['not JSON']);
});

test('paper panel: an expert reply cut off stops the session incomplete; an interviewer passing on hidden text is stopped before the candidate sees it', async () => {
  const cut = (req) => isInterviewer(req) ? { text: 'Opening.' } : isExpert(req) ? { text: '{"reasoning": "occ', stop: 'length' } : { text: '{}' };
  expect((await run(paperStudy(true), cut)).o).toMatchObject({ status: 'incomplete', reason: 'error:malformed' });
  const leaky = (req) => isInterviewer(req) ? { text: turnsLeft(req) === 12 ? 'Opening.' : 'Hint: cut the four low-occupancy winter crossings.' } : { text: '{"reply": "What matters?"}' };
  const { fake, o } = await run(paperStudy(), leaky);
  expect(o).toMatchObject({ status: 'incomplete', reason: 'secret_guard' });
  expect(fake.seen.filter(q => !isInterviewer(q)).every(q => !all(q).includes('cut the four'))).toBe(true);
});

test('the study check: paper prompts need the paper settings, three experts and a secret in every case', () => {
  const s = paperStudy(true, (c) => ({ ...c, hint_marker: 'HINT:', seats: { ...c.seats, expert: ['fake:alpha', 'fake:beta'] } }));
  delete s.cases[0].secret;
  s.roles.interviewer.sees = ['task', 'materials'];
  let msg = '';
  try { checkStudy(s); } catch (e) { msg = e.message; }
  expect(msg).toContain('paper prompts require no added final notice, marker or hint marker');
  expect(msg).toContain('paper discussion requires three experts');
  expect(msg).toContain('paper interviewer must see the full case secret');
  expect(msg).toContain('has none');
});
