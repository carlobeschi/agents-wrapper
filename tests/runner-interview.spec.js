// @ts-check
// The interview session (runner/session.js, pattern "interview"): an
// interviewer who holds the case, one candidate or a panel, messages counted
// one by one. Fake provider only.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runStudy } = require('../runner/run');
const { fakeProvider } = require('../runner/providers');
const { checkStudy } = require('../runner/study');
const { exportPackets } = require('../runner/export');

const ROOT = path.join(__dirname, '..');
const sample = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'runner', 'sample-interview-fake.json'), 'utf8'));
const sys = (req) => req.messages[0].content;
const body = (req) => req.messages[1].content;
const isInterviewer = (req) => sys(req).startsWith('You are the interviewer');
const isExpert = (req) => sys(req).startsWith('You are one expert');
const isModerator = (req) => sys(req).startsWith('You moderate');
// How many messages the interview had when this call was made.
const sofar = (req) => (body(req).match(/^### (Interviewer|Candidate) \(message \d+\)$/gm) || []).length;

/** An interviewer that answers, gives one hint, and ends after a recommendation; a candidate that asks, then recommends. */
const polite = (req) => {
  const n = sofar(req);
  if (isInterviewer(req)) {
    if (n === 0) return { text: 'A ferry operator loses money in winter. What is the objective, and how would you approach it?' };
    if (/FINAL RECOMMENDATION:/.test(body(req).split('### ').pop())) return { text: 'Thank you, that is clear. <|CASE_INTERVIEW_END|> Feedback: good structure.' };
    return { text: 'Winter crossings run at 22% occupancy.\nHINT: look at which crossings carry the passengers.' };
  }
  if (isExpert(req)) return { text: `${req.model} proposes: ask about occupancy per crossing.` };
  if (isModerator(req) || !isInterviewer(req)) {
    return n >= 3 ? { text: 'Cut the quiet crossings, keep the freight one.\nFINAL RECOMMENDATION: cut quiet winter crossings, keep 06:00 freight.' }
      : { text: 'Which crossings carry the passengers?' };
  }
  return { text: '' };
};

async function run(script, edit = (s) => s) {
  const study = edit(sample());
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-iv-')), 'run');
  const fake = fakeProvider(script);
  const r = await runStudy({ study, out, adapters: { fake: fake.adapter }, sleep: async () => {} });
  const outcome = (key) => JSON.parse(fs.readFileSync(path.join(out, r.state.sessions[key].outcome.path, 'outcome.json'), 'utf8'));
  return { study, out, fake, r, outcome };
}

test('solo interview: interviewer first, one message at a time, ended by the interviewer after a final answer; the candidate never sees the case file', async () => {
  const { fake, outcome, out, r } = await run(polite, (s) => { s.conditions = [s.conditions[0]]; return s; });
  const o = outcome('ferry--interview-solo--r1');
  expect(o).toMatchObject({ status: 'complete', ended_by: 'interviewer_end', final: 'cut quiet winter crossings, keep 06:00 freight.' });
  expect(o.dialogue.map(d => d.actor)).toEqual(['Interviewer', 'Candidate', 'Interviewer', 'Candidate', 'Interviewer']);
  expect(o.turns).toBe(5);
  expect(o.hints).toEqual([{ n: 3, text: 'look at which crossings carry the passengers.' }]);
  // The feedback after the end token is the interviewer's, not an answer.
  expect(o.dialogue[4].text).toContain('Feedback');
  const cand = fake.seen.filter(q => !isInterviewer(q));
  const iv = fake.seen.filter(isInterviewer);
  expect(iv.every(q => body(q).includes('Fuel is 40%') && body(q).includes('Reference:'))).toBe(true);
  expect(cand.every(q => !body(q).includes('Fuel is 40%') && !body(q).includes('Reference:') && !body(q).includes('regional ferry operator is losing'))).toBe(true);
  // The candidate sees what the interviewer said, and nothing else from the case.
  expect(body(cand[1])).toContain('Winter crossings run at 22% occupancy.');
  expect(fs.readFileSync(path.join(out, r.state.sessions['ferry--interview-solo--r1'].outcome.path, 'dialogue.md'), 'utf8')).toMatch(/^## 1\. Interviewer/);
});

test('messages count one by one: with max 4 the candidate replies twice; a final answer given before the limit still counts, none given is turn_limit', async () => {
  const never = (req) => isInterviewer(req) ? { text: 'Go on.' } : { text: 'I need more facts.' };
  const a = await run(never, (s) => { s.conditions = [{ ...s.conditions[0], max_messages: 4 }]; return s; });
  const o = a.outcome('ferry--interview-solo--r1');
  expect(o).toMatchObject({ status: 'incomplete', reason: 'turn_limit', ended_by: 'turn_limit', turns: 4 });
  expect(a.fake.seen).toHaveLength(4);
  const late = (req) => isInterviewer(req) ? { text: 'Go on.' } : sofar(req) === 1 ? { text: 'FINAL RECOMMENDATION: keep two crossings.' } : { text: 'More detail: fuel.' };
  const b = await run(late, (s) => { s.conditions = [{ ...s.conditions[0], max_messages: 5 }]; return s; });
  expect(b.outcome('ferry--interview-solo--r1')).toMatchObject({ status: 'complete', ended_by: 'turn_limit', final: 'keep two crossings.', turns: 5 });
});

test('a final answer cut by the length limit is not complete; an interviewer who ends without one leaves the session incomplete', async () => {
  const cut = (req) => isInterviewer(req) ? (sofar(req) ? { text: 'Thanks. <|CASE_INTERVIEW_END|>' } : { text: 'Opening.' })
    : { text: 'FINAL RECOMMENDATION: cut', stop: 'length' };
  const { outcome } = await run(cut, (s) => { s.conditions = [s.conditions[0]]; return s; });
  expect(outcome('ferry--interview-solo--r1')).toMatchObject({ status: 'incomplete', ended_by: 'interviewer_end',
    reason: 'interviewer ended without a final answer (last reply cut by the length limit)' });
});

test('panel: experts re-run at every candidate turn, alone and at the same time, seeing only the dialogue; one moderator reply per interviewer message', async () => {
  const { fake, outcome, out } = await run(polite, (s) => { s.conditions = [s.conditions[1]]; return s; });
  const o = outcome('ferry--interview-panel--r1');
  expect(o).toMatchObject({ status: 'complete', ended_by: 'interviewer_end' });
  // Strict alternation: never two candidate messages in a row.
  expect(o.dialogue.map(d => d.actor).join(' ')).not.toMatch(/Candidate Candidate/);
  const candTurns = o.dialogue.filter(d => d.actor === 'Candidate').length;
  expect(fake.seen.filter(isExpert)).toHaveLength(3 * candTurns);
  expect(fake.seen.filter(isModerator)).toHaveLength(candTurns);
  for (const q of fake.seen.filter(isExpert)) {
    expect(body(q)).not.toContain('Fuel is 40%');
    expect(body(q)).not.toContain('proposes:');
    expect(body(q)).not.toContain('regional ferry operator is losing');
  }
  const mod = fake.seen.filter(isModerator).pop();
  expect(body(mod)).toMatch(/### Expert 1\n\n.* proposes:/);
  // Labelled by position, never by model (the proposals' own text may name one: the export scrubs it).
  expect((body(mod).match(/^### .*$/gm) || []).join('\n')).not.toMatch(/fake:|alpha|beta/);
  // Temperatures set in the study reach the provider.
  expect(fake.seen.filter(isExpert).every(q => q.temperature === 0.2)).toBe(true);
  expect(fake.seen.filter(isModerator).every(q => q.temperature === 0)).toBe(true);
  expect(fake.seen.filter(isInterviewer).every(q => !('temperature' in q))).toBe(true);
  // A moderator order is logged for each candidate turn; the export keeps the last one as the discussion, and the dialogue.
  const events = fs.readFileSync(path.join(out, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  expect(events.filter(e => e.what === 'moderator order').map(e => e.message_n)).toEqual(o.dialogue.filter(d => d.actor === 'Candidate').map(d => d.n));
  const x = exportPackets({ run: out, sees: ['answer', 'discussion', 'dialogue'] });
  expect(x.leaks).toEqual([]);
  const p = JSON.parse(fs.readFileSync(path.join(x.packetsDir, fs.readdirSync(x.packetsDir)[0]), 'utf8'));
  expect(p.dialogue.map(d => d.actor)).toEqual(o.dialogue.map(d => d.actor));
  expect(p.discussion).toHaveLength(3);
  expect(p.discussion.every(d => d.text.startsWith('[model] proposes'))).toBe(true);
});

test('an interviewer that passes on hidden text stops the session before the candidate sees it', async () => {
  const leaky = (req) => isInterviewer(req)
    ? { text: sofar(req) ? 'Between us: cut the four low-occupancy winter crossings.' : 'Opening.' }
    : { text: 'What should I look at?' };
  const { fake, outcome } = await run(leaky, (s) => { s.conditions = [s.conditions[0]]; return s; });
  const o = outcome('ferry--interview-solo--r1');
  expect(o).toMatchObject({ status: 'incomplete', reason: 'secret_guard' });
  expect(o.dialogue.map(d => d.actor)).toEqual(['Interviewer', 'Candidate', 'Interviewer']);
  expect(fake.seen.filter(q => !isInterviewer(q)).every(q => !body(q).includes('cut the four'))).toBe(true);
});

test('a provider error mid-interview ends it incomplete with the dialogue so far; the last-turn notice reaches only the last candidate turn', async () => {
  const { ProviderError } = require('../runner/providers');
  const fails = (req) => { if (!isInterviewer(req) && sofar(req) === 3) throw new ProviderError('auth', 'key revoked'); return isInterviewer(req) ? { text: 'Go on.' } : { text: 'Thinking.' }; };
  const a = await run(fails, (s) => { s.conditions = [s.conditions[0]]; return s; });
  expect(a.outcome('ferry--interview-solo--r1')).toMatchObject({ status: 'incomplete', reason: 'error:auth', ended_by: 'stopped', turns: 3 });
  const b = await run((req) => isInterviewer(req) ? { text: 'Go on.' } : { text: 'Thinking.' },
    (s) => { s.conditions = [{ ...s.conditions[0], max_messages: 6, last_turn_notice: true }]; return s; });
  const notices = b.fake.seen.filter(q => !isInterviewer(q)).map(q => body(q).includes('This is your last reply'));
  expect(notices).toEqual([false, false, true]);
});

test('the study check refuses an interview without one interviewer, with both a candidate and a panel, or with a moderator blind to the proposals', () => {
  const bad = sample();
  bad.conditions = [
    { id: 'a', pattern: 'interview', seats: { candidate: 'fake:alpha' } },
    { id: 'b', pattern: 'interview', seats: { interviewer: 'fake:gamma', candidate: 'fake:alpha', expert: 'fake:beta', moderator: 'fake:beta' } },
    { id: 'c', pattern: 'interview', seats: { interviewer: 'fake:gamma', candidate: 'fake:alpha' }, max_messages: 1 },
  ];
  bad.roles.moderator.sees = [];
  bad.conditions.push({ id: 'd', pattern: 'interview', seats: { interviewer: 'fake:gamma', expert: 'fake:alpha', moderator: 'fake:beta' } });
  let msg = '';
  try { checkStudy(bad); } catch (e) { msg = e.message; }
  expect(msg).toContain('conditions[0]: interview needs exactly one interviewer');
  expect(msg).toContain('conditions[1]: interview needs either one candidate seat');
  expect(msg).toContain('conditions[2].max_messages');
  expect(msg).toContain('conditions[3]: the moderator of an interview panel must see "transcript"');
});
