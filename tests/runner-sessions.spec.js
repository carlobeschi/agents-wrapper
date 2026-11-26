// @ts-check
// runner/session.js, runner/run.js, runner/view.js: sessions, completion,
// what each role sees, checkpoints and resume. Fake provider only.
const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runStudy } = require('../runner/run');
const { fakeProvider } = require('../runner/providers');
const { view } = require('../runner/view');
const { EventLog } = require('../runner/events');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'examples', 'runner', 'sample-fake.json');
const sample = () => JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'runner-ses-'));
const markerOf = (req) => (/starts with "([^"]+)" followed by your final answer/.exec(req.messages.map(m => m.content).join('\n')) || [])[1];
const prompt = (req) => req.messages.map(m => m.content).join('\n');

// Experts analyse; whoever is asked to close does so.
const polite = (req) => markerOf(req) ? { text: `Done.\n${markerOf(req)} Lower the prices again.` } : { text: `Analysis by ${req.model}: look at prices.` };

async function run(study, script, extra = {}) {
  const out = path.join(tmp(), 'run');
  const fake = fakeProvider(script);
  const lines = [];
  const r = await runStudy({ study, out, adapters: { fake: fake.adapter }, say: l => lines.push(l), sleep: async () => {}, ...extra });
  return { ...r, out, fake, lines, log: new EventLog(out) };
}

const outcomes = (out) => JSON.parse(fs.readFileSync(path.join(out, 'state.json'), 'utf8')).sessions;

test('the sample study runs solo, same-family and mixed on both cases; every session closes with its final line', async () => {
  const { out, lines, log } = await run(sample(), polite);
  const s = outcomes(out);
  expect(Object.keys(s)).toEqual(['bakery--solo--r1', 'bakery--same-family--r1', 'bakery--mixed--r1', 'clinic--solo--r1', 'clinic--same-family--r1', 'clinic--mixed--r1']);
  for (const v of Object.values(s)) expect(v.outcome).toMatchObject({ status: 'complete', reason: null });
  const o = JSON.parse(fs.readFileSync(path.join(out, s['bakery--mixed--r1'].outcome.path, 'outcome.json'), 'utf8'));
  expect(o.final).toBe('Lower the prices again.');
  expect(o.seats.map(x => [x.seat, x.model, x.label])).toEqual([['expert#1', 'fake:alpha', 'Expert 1'], ['expert#2', 'fake:beta', 'Expert 2'], ['moderator#1', 'fake:alpha', 'Moderator']]);
  expect(lines.at(-1)).toMatch(/^Spent \$0\.\d+ of \$1/);
  const ses = log.all().filter(e => e.kind === 'session');
  expect(ses).toHaveLength(6);
  expect(ses[0]).toMatchObject({ case: 'bakery', condition: 'solo', pattern: 'solo', attempt: 1, retry_of: null });
});

test('the secret never reaches an expert or a moderator; the judge sees it, and only what its role allows', async () => {
  const study = sample();
  const { fake, out } = await run(study, polite);
  expect(fake.seen.length).toBeGreaterThan(10);
  for (const req of fake.seen) for (const c of study.cases) expect(prompt(req)).not.toContain(c.secret);
  // Nor in any text the participants were shown (payloads hold every prompt as sent).
  const log = new EventLog(out);
  for (const e of log.all().filter(x => x.kind === 'call')) for (const c of study.cases) expect(log.get(e.prompt_ref)).not.toContain(c.secret);
  // Experts see task and materials, not the others; the moderator sees task and the analyses, not the materials.
  const expertReq = fake.seen.find(r => r.messages[0].content === study.roles.expert.prompt);
  expect(prompt(expertReq)).toContain('Material: facts.md');
  expect(prompt(expertReq)).not.toContain('What the others wrote');
  const modReq = fake.seen.find(r => r.messages[0].content === study.roles.moderator.prompt);
  expect(prompt(modReq)).not.toContain('Material: facts.md');
  expect(prompt(modReq)).toContain('### Expert 1');
  // Seats are labelled, not named: no model id in the moderator's prompt (the fake's own text says "alpha", which is its reply, not a label).
  expect(prompt(modReq)).not.toContain('fake:');
  // The judge's view: task, reference notes, transcript; no materials.
  const kase = study.cases[0];
  const j = view({ role: study.roles.judge, roleName: 'judge', kase, transcript: [{ label: 'Moderator', text: 'x' }] });
  expect(j[1].content).toContain(kase.secret);
  expect(j[1].content).not.toContain('Material: facts.md');
});

test('an expert who repeats the secret cannot pass it on: the moderator is never called and the session says why', async () => {
  const study = sample();
  study.conditions = [study.conditions[2]];
  study.cases = [study.cases[0]];
  const leak = (req) => markerOf(req) ? { text: 'unreachable' } : { text: `I happen to know: ${study.cases[0].secret}` };
  const { fake, out, log } = await run(study, leak);
  expect(outcomes(out)['bakery--mixed--r1'].outcome).toMatchObject({ status: 'incomplete', reason: 'secret_guard' });
  expect(fake.seen.filter(r => markerOf(r))).toHaveLength(0);
  expect(log.all().find(e => e.what === 'secret guard').message).toContain('would reach moderator');
});

test('a turn limit is never a completed answer: the session is incomplete and its last reply is kept', async () => {
  const study = sample();
  study.limits.turns = 3;
  study.conditions = [study.conditions[0]];
  study.cases = [study.cases[0]];
  const { out, log, fake } = await run(study, () => ({ text: 'Let me think about it some more.' }));
  const v = outcomes(out)['bakery--solo--r1'].outcome;
  expect(v).toMatchObject({ status: 'incomplete', reason: 'turn_limit' });
  expect(fake.seen).toHaveLength(3);
  expect(fs.readFileSync(path.join(out, v.path, 'closing.md'), 'utf8')).toBe('Let me think about it some more.');
  expect(prompt(fake.seen[1])).toContain('That reply had no final-answer line.');
  expect(log.all().find(e => e.kind === 'outcome')).toMatchObject({ status: 'incomplete', reason: 'turn_limit', final_ref: null, turns: 3 });
});

test('a reply cut by the length limit does not count even with the final line in it; the next turn can close', async () => {
  const study = sample();
  study.conditions = [study.conditions[0]];
  study.cases = [study.cases[0]];
  const steps = [{ text: 'FINAL RECOMMENDATION: Lower the', stop: 'length' }, { text: 'FINAL RECOMMENDATION: Lower the prices.' }];
  const { out, fake } = await run(study, (req, n) => steps[n]);
  expect(outcomes(out)['bakery--solo--r1'].outcome.status).toBe('complete');
  expect(prompt(fake.seen[1])).toContain('cut off by the length limit');
  const o = JSON.parse(fs.readFileSync(path.join(out, outcomes(out)['bakery--solo--r1'].outcome.path, 'outcome.json'), 'utf8'));
  expect(o.final).toBe('Lower the prices.');
});

test('an explicit early end is recorded as ended early, with its reason', async () => {
  const study = sample();
  study.conditions = [study.conditions[0]];
  study.cases = [study.cases[0]];
  const { out } = await run(study, () => ({ text: 'EARLY END: the materials contradict the task.' }));
  expect(outcomes(out)['bakery--solo--r1'].outcome).toMatchObject({ status: 'ended_early', reason: 'the materials contradict the task.' });
});

test('peer consultation: one question, one answer, one revision, and the moderator reads the revision', async () => {
  const study = sample();
  study.conditions = [{ ...study.conditions[2], peer_consultation: true }];
  study.cases = [study.cases[0]];
  const script = (req) => {
    const p = prompt(req);
    if (markerOf(req)) return { text: `${markerOf(req)} ok` };
    if (p.includes('A question from another expert')) return { text: 'ANSWER: check the receipts.' };
    if (p.includes('The answer you got')) return { text: `REVISED by ${req.model}` };
    return { text: req.model === 'alpha' ? 'First take.\nASK PEER: what about the receipts?' : 'Beta take, no question.' };
  };
  const { fake, out } = await run(study, script);
  expect(outcomes(out)['bakery--mixed--r1'].outcome.status).toBe('complete');
  const asked = fake.seen.find(r => prompt(r).includes('A question from another expert'));
  expect(asked.model).toBe('beta');
  expect(prompt(asked)).toContain('what about the receipts?');
  const mod = fake.seen.find(r => markerOf(r));
  expect(prompt(mod)).toContain('REVISED by alpha');
  expect(prompt(mod)).toContain('Beta take, no question.');
  expect(prompt(mod)).not.toContain('ASK PEER');
});

test('a provider error ends the session as incomplete; a plain resume keeps it, --retry-errors runs it as a new attempt', async () => {
  const study = sample();
  study.conditions = [study.conditions[0]];
  study.cases = [study.cases[0]];
  study.limits.retries = 0;
  const out = path.join(tmp(), 'run');
  const go = (script, extra = {}) => runStudy({ study, out, adapters: { fake: fakeProvider(script).adapter }, sleep: async () => {}, ...extra });
  await go(() => ({ error: 'server' }));
  expect(outcomes(out)['bakery--solo--r1'].outcome).toMatchObject({ status: 'incomplete', reason: 'error:server' });
  await go(polite);
  expect(outcomes(out)['bakery--solo--r1'].attempts).toHaveLength(1);
  await go(polite, { retry_errors: true });
  const s = outcomes(out)['bakery--solo--r1'];
  expect(s.attempts).toHaveLength(2);
  expect(s.outcome.status).toBe('complete');
  expect(fs.readdirSync(path.join(out, 'sessions', 'bakery--solo--r1'))).toHaveLength(2);
});

test('the run spend cap stops the run between sessions; raised, the run goes on and keeps what was done', async () => {
  const study = sample();
  study.cases = [study.cases[0]];
  study.conditions = [study.conditions[0], study.conditions[2]];
  // fake:alpha holds 800 x $5/M = $0.004 per call, plus a little input: one solo session fits in $0.005, a mixed one does not.
  study.spend.run_usd = 0.005;
  const out = path.join(tmp(), 'run');
  const first = await runStudy({ study, out, adapters: { fake: fakeProvider(polite).adapter }, sleep: async () => {} });
  expect(first.stopped).toBe('the run spend cap');
  expect(outcomes(out)['bakery--mixed--r1'].outcome.reason).toBe('budget_run');
  const solo = outcomes(out)['bakery--solo--r1'];
  await runStudy({ study, out, run_usd: 1, adapters: { fake: fakeProvider(polite).adapter }, sleep: async () => {} });
  const s = outcomes(out);
  expect(s['bakery--solo--r1']).toEqual(solo);
  expect(s['bakery--mixed--r1'].attempts).toHaveLength(2);
  expect(s['bakery--mixed--r1'].outcome.status).toBe('complete');
});

test('a folder started with one study refuses another', async () => {
  const study = sample();
  study.cases = [study.cases[0]];
  study.conditions = [study.conditions[0]];
  const out = path.join(tmp(), 'run');
  await runStudy({ study, out, adapters: { fake: fakeProvider(polite).adapter } });
  study.cases[0].task += ' Changed.';
  await expect(runStudy({ study, out, adapters: { fake: fakeProvider(polite).adapter } })).rejects.toThrow(/different study file/);
});

test('stopped after one session, the run resumes: the finished session is untouched, the stopped one runs again with a new id', async () => {
  const out = path.join(tmp(), 'run');
  const env = { ...process.env, RUNNER_FAKE_DELAY_MS: '150' };
  const child = spawn('node', [path.join(ROOT, 'runner.js'), 'run', SAMPLE, '--out', out], { env, stdio: 'ignore' });
  const stateFile = path.join(out, 'state.json');
  // Wait until session 1 has its outcome and session 2 has started, then stop the process hard.
  const deadline = Date.now() + 20000;
  for (;;) {
    let s = {};
    try { s = JSON.parse(fs.readFileSync(stateFile, 'utf8')).sessions; } catch {}
    const two = s['bakery--same-family--r1'];
    if (s['bakery--solo--r1']?.outcome && two && !two.outcome) break;
    if (Date.now() > deadline) throw new Error('the run did not reach session 2 in time');
    await new Promise(r => setTimeout(r, 20));
  }
  child.kill('SIGKILL');
  await new Promise(r => child.on('exit', r));

  const before = JSON.parse(fs.readFileSync(stateFile, 'utf8')).sessions;
  const firstDir = path.join(out, before['bakery--solo--r1'].outcome.path);
  const firstFiles = Object.fromEntries(fs.readdirSync(firstDir).map(f => [f, fs.readFileSync(path.join(firstDir, f), 'utf8')]));
  const stoppedId = before['bakery--same-family--r1'].attempts[0].session_id;

  const again = spawn('node', [path.join(ROOT, 'runner.js'), 'run', SAMPLE, '--out', out], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  let said = '';
  again.stdout.on('data', d => { said += d; });
  const code = await new Promise(r => again.on('exit', r));
  expect(code).toBe(0);
  expect(said).toContain('1/6 bakery--solo--r1: already complete, kept');
  expect(said).toContain('2/6 bakery--same-family--r1: running (attempt 2)');

  const after = JSON.parse(fs.readFileSync(stateFile, 'utf8')).sessions;
  expect(after['bakery--solo--r1']).toEqual(before['bakery--solo--r1']);
  for (const [f, text] of Object.entries(firstFiles)) expect(fs.readFileSync(path.join(firstDir, f), 'utf8')).toBe(text);
  const two = after['bakery--same-family--r1'];
  expect(two.attempts.map(a => a.session_id)).toHaveLength(2);
  expect(two.attempts[1].session_id).not.toBe(stoppedId);
  expect(two.outcome.session_id).toBe(two.attempts[1].session_id);
  for (const v of Object.values(after)) expect(v.outcome.status).toBe('complete');
  const events = new EventLog(out).all();
  expect(events.find(e => e.kind === 'session' && e.retry_of === stoppedId)).toMatchObject({ attempt: 2, why_again: 'previous attempt stopped before its outcome' });
  // Every attempt id in the record is unique.
  const calls = events.filter(e => e.kind === 'call').map(e => e.attempt_id);
  expect(new Set(calls).size).toBe(calls.length);
});
