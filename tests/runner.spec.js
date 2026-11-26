// @ts-check
// runner.js and runner/: the research runner's core (study check, event
// record, shared budget, one model call with bounded retries). Every call goes
// to the fake provider; nothing here reaches the network.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkStudy } = require('../runner/study');
const { EventLog } = require('../runner/events');
const { Ledger, BudgetError } = require('../runner/budget');
const { fakeProvider, ProviderError } = require('../runner/providers');
const { callModel } = require('../runner/call');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'examples', 'runner', 'sample-fake.json');
const sample = () => JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'runner-'));

// fake:priced costs $1 per 1,000 output tokens and nothing for input, so a
// call with 100 output tokens allowed holds exactly $0.10.
const PRICES = { 'fake:priced': { in_per_mtok: 0, out_per_mtok: 1000, as_of: '2026-11-26' } };

function rig({ run_usd = 10, session_usd = null, script }) {
  const dir = tmp();
  const log = new EventLog(dir);
  const ledger = new Ledger({ file: path.join(dir, 'ledger.jsonl'), run_usd, session_usd, prices: PRICES });
  const fake = fakeProvider(script);
  const call = (extra = {}) => callModel({
    log, ledger, adapters: { fake: fake.adapter }, session_id: 'ses_1', role: 'expert', seat: 'expert#1', model: 'fake:priced',
    messages: [{ role: 'user', content: 'Task: say hello.' }], prompt_version: 'v1', max_output_tokens: 100, timeout_s: 5, retries: 2,
    reply_visible_to: ['moderator'], evaluator_visible: true, sleep: async () => {}, ...extra,
  });
  return { dir, log, ledger, fake, call };
}

test.describe('study file', () => {
  test('the sample study is valid and the CLI says what it would run', () => {
    expect(() => checkStudy(sample())).not.toThrow();
    const out = execFileSync('node', [path.join(ROOT, 'runner.js'), 'check', SAMPLE], { encoding: 'utf8' });
    expect(out).toContain('2 case(s) x 3 condition(s) x 1 repeat(s) = 6 session(s)');
    expect(out).toContain('mixed (experts_moderator): expert=fake:alpha+fake:beta, moderator=fake:alpha');
  });

  test('a study that would show the secret to an expert or a moderator is refused before any call', () => {
    const s = sample();
    s.roles.expert.sees.push('secret');
    s.roles.moderator.sees.push('secret');
    expect(() => checkStudy(s)).toThrow(/roles.expert: a expert may not see "secret"[\s\S]*roles.moderator: a moderator may not see "secret"/);
    const j = sample();
    j.roles.judge.kind = 'candidate';
    expect(() => checkStudy(j)).toThrow(/a candidate may not see "secret"/);
  });

  test('a secret copied into the task or the materials is refused', () => {
    const s = sample();
    s.cases[0].materials['facts.md'] += ' ' + s.cases[0].secret;
    expect(() => checkStudy(s)).toThrow(/the secret is written inside materials "facts.md"/);
  });

  test('every problem is listed at once: missing price, bad model name, no final-answer rule, no spend cap', () => {
    const s = sample();
    s.conditions[0].seats.expert = 'anthropic:claude-opus-5-5';
    s.conditions[1].seats.moderator = 'claude-opus-5-5';
    delete s.cases[1].final_answer;
    delete s.spend.run_usd;
    let msg = '';
    try { checkStudy(s); } catch (e) { msg = e.message; }
    expect(msg).toContain('prices["anthropic:claude-opus-5-5"]: needed');
    expect(msg).toContain('"claude-opus-5-5" must be provider:model');
    expect(msg).toContain('cases[1].final_answer.marker: required');
    expect(msg).toContain('spend.run_usd: required');
  });
});

test.describe('one call', () => {
  test('a complete reply is recorded with its exact prompt, model identity and reported cost', async () => {
    const { log, ledger, call } = rig({ script: { priced: [{ text: 'hello', input_tokens: 12, output_tokens: 3, cost_usd: 0.004 }] } });
    const r = await call({ seed: 7 });
    expect(r.text).toBe('hello');
    expect(r.truncated).toBe(false);
    const evs = log.all();
    expect(evs.map(e => e.kind)).toEqual(['call', 'reply']);
    const [c, rep] = evs;
    expect(JSON.parse(log.get(c.prompt_ref))).toEqual([{ role: 'user', content: 'Task: say hello.' }]);
    expect(c).toMatchObject({ provider: 'fake', model: 'fake:priced', prompt_version: 'v1', seed: 7, attempt: 1, session_id: 'ses_1', reserved_usd: 0.1 });
    expect(rep).toMatchObject({ parent_id: c.event_id, attempt_id: c.attempt_id, model_returned: 'fake-priced', stop: 'complete', cost_usd: 0.004, cost_basis: 'reported', visible_to: ['moderator'] });
    expect(log.get(rep.text_ref)).toBe('hello');
    expect(ledger.totals()).toMatchObject({ reported_usd: 0.004, estimated_usd: 0, held_usd: 0, total_usd: 0.004 });
  });

  test('a malformed reply is retried a bounded number of times; every attempt is kept and charged', async () => {
    const { log, ledger, call } = rig({ script: { priced: [{ malformed: '{"choices": [' }, { malformed: '{"text": 5}' }, { text: 'ok', input_tokens: 0, output_tokens: 10 }] } });
    const r = await call();
    expect(r.text).toBe('ok');
    expect(r.attempts.map(a => a.ok)).toEqual([false, false, true]);
    expect(new Set(r.attempts.map(a => a.attempt_id)).size).toBe(3);
    const evs = log.all();
    expect(evs.map(e => e.kind)).toEqual(['call', 'error', 'retry', 'call', 'error', 'retry', 'call', 'reply']);
    const errs = evs.filter(e => e.kind === 'error');
    expect(errs.map(e => e.error)).toEqual(['malformed', 'malformed']);
    expect(log.get(errs[0].raw_ref)).toBe('{"choices": [');
    // Malformed replies may have been billed: charged at the full $0.10 each, marked estimated.
    expect(ledger.totals()).toMatchObject({ estimated_usd: 0.2, computed_usd: 0.01, total_usd: 0.21 });
  });

  test('a reply cut by the output limit is kept as truncated, not retried and not made complete', async () => {
    const { log, call } = rig({ script: { priced: [{ text: 'My recommendation is to', stop: 'length', output_tokens: 100 }, { text: 'never used' }] } });
    const r = await call();
    expect(r.truncated).toBe(true);
    expect(r.stop).toBe('length');
    expect(r.text).toBe('My recommendation is to');
    expect(r.attempts).toHaveLength(1);
    const rep = log.all().find(e => e.kind === 'reply');
    expect(rep).toMatchObject({ stop: 'length', truncated: true });
  });

  test('a rate limit waits as told, is not charged, and the retry gets a new attempt id', async () => {
    const waits = [];
    const { log, ledger, call } = rig({ script: { priced: [{ error: 'rate_limit', retry_after_ms: 1500 }, { text: 'ok', output_tokens: 5, cost_usd: 0.001 }] } });
    const r = await call({ sleep: async (ms) => { waits.push(ms); } });
    expect(waits).toEqual([1500]);
    expect(r.attempts[0].attempt_id).not.toBe(r.attempts[1].attempt_id);
    const err = log.all().find(e => e.kind === 'error');
    expect(err).toMatchObject({ error: 'rate_limit', cost_usd: 0, retryable: true });
    expect(ledger.totals().total_usd).toBe(0.001);
  });

  test('a call that never answers is stopped at the time limit, retried, and its cost counted as unknown', async () => {
    const { log, ledger, call } = rig({ script: { priced: [{ hang: true }, { text: 'late but fine', output_tokens: 10 }] } });
    const r = await call({ timeout_s: 0.2 });
    expect(r.text).toBe('late but fine');
    const err = log.all().find(e => e.kind === 'error');
    expect(err).toMatchObject({ error: 'timeout', cost_basis: 'estimated', cost_usd: 0.1 });
    expect(ledger.totals()).toMatchObject({ estimated_usd: 0.1, computed_usd: 0.01 });
  });

  test('when the retries run out the error says what happened to every attempt', async () => {
    const { log, call } = rig({ script: { priced: [{ error: 'server' }, { error: 'server' }, { error: 'server' }, { text: 'too late' }] } });
    const e = await call().catch(x => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.kind).toBe('server');
    expect(e.attempts.map(a => a.error)).toEqual(['server', 'server', 'server']);
    expect(log.all().filter(x => x.kind === 'call')).toHaveLength(3);
  });

  test('an error that cannot pass (bad key) is not retried', async () => {
    const { log, call } = rig({ script: { priced: [{ error: 'auth' }, { text: 'never' }] } });
    await expect(call()).rejects.toMatchObject({ kind: 'auth' });
    expect(log.all().filter(x => x.kind === 'call')).toHaveLength(1);
  });

  test('unknown billing (no cost, no tokens) is charged at the full reservation and shown as estimated', async () => {
    const { ledger, call, dir } = rig({ script: { priced: [{ text: 'ok', input_tokens: null, output_tokens: null }] } });
    await call();
    expect(ledger.totals()).toMatchObject({ estimated_usd: 0.1, reported_usd: 0, computed_usd: 0, total_usd: 0.1 });
    const out = execFileSync('node', [path.join(ROOT, 'runner.js'), 'budget', dir], { encoding: 'utf8' });
    expect(out).toContain('estimated (cost unknown) $0.1000');
  });
});

test.describe('shared budget', () => {
  test('parallel calls reserve before they start: only those that fit run, and the cap is never passed', async () => {
    const { log, ledger, call } = rig({ run_usd: 0.3, script: () => ({ text: 'ok', output_tokens: 100, delay_ms: 50 }) });
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(i => call({ session_id: `ses_${i}` })));
    const ok = results.filter(r => r.status === 'fulfilled');
    const refused = results.filter(r => r.status === 'rejected');
    expect(ok).toHaveLength(3);
    expect(refused).toHaveLength(2);
    for (const r of refused) expect(/** @type {PromiseRejectedResult} */ (r).reason).toBeInstanceOf(BudgetError);
    expect(ledger.totals().total_usd).toBeLessThanOrEqual(0.3);
    expect(log.all().filter(e => e.kind === 'budget' && e.refused)).toHaveLength(2);
  });

  test('a session cap stops that session only; the run goes on for others', async () => {
    const { call } = rig({ run_usd: 10, session_usd: 0.25, script: () => ({ text: 'ok', output_tokens: 100 }) });
    await call({ session_id: 'a' });
    await call({ session_id: 'a' });
    await expect(call({ session_id: 'a' })).rejects.toMatchObject({ name: 'BudgetError', scope: 'session' });
    await expect(call({ session_id: 'b' })).resolves.toMatchObject({ text: 'ok' });
  });

  test('when the run budget is spent no call is made at all', async () => {
    const { fake, call } = rig({ run_usd: 0.1, script: () => ({ text: 'ok', output_tokens: 100 }) });
    await call();
    await expect(call()).rejects.toMatchObject({ scope: 'run' });
    expect(fake.seen).toHaveLength(1);
  });

  test('a run stopped mid-call resumes with that call counted as spent in full', () => {
    const dir = tmp();
    const file = path.join(dir, 'ledger.jsonl');
    const first = new Ledger({ file, run_usd: 1, prices: PRICES });
    first.reserve({ session_id: 's', attempt_id: 'att_1', model: 'fake:priced', input_chars: 0, max_output_tokens: 100 });
    // The process stops here. A report while it may still be running shows it as held:
    expect(new Ledger({ file, run_usd: 1, prices: PRICES, readonly: true }).totals()).toMatchObject({ held_usd: 0.1, estimated_usd: 0 });
    // The resumed run counts it in full:
    const again = new Ledger({ file, run_usd: 1, prices: PRICES });
    expect(again.totals()).toMatchObject({ estimated_usd: 0.1, held_usd: 0, total_usd: 0.1 });
    expect(new Ledger({ file, run_usd: 1, prices: PRICES }).totals().total_usd).toBe(0.1);
  });

  test('a model with no price cannot be called', async () => {
    const { log, call } = rig({ script: () => ({ text: 'ok' }) });
    await expect(call({ model: 'fake2:x' })).rejects.toThrow(/no adapter/);
    const ledger = new Ledger({ file: path.join(tmp(), 'l.jsonl'), run_usd: 1, prices: {} });
    expect(() => ledger.reserve({ session_id: 's', attempt_id: 'a', model: 'openai:gpt-6-luna', input_chars: 10, max_output_tokens: 10 })).toThrow(/no price for openai:gpt-6-luna/);
    expect(log.all()).toHaveLength(0);
  });
});

test.describe('event record', () => {
  test('texts are stored once, readable by the owner only, and every event states who may see it', () => {
    const log = new EventLog(tmp());
    const a = log.put('case text'), b = log.put('case text');
    expect(a).toBe(b);
    const f = path.join(log.payloads, a.slice(7) + '.txt');
    if (process.platform !== 'win32') expect(fs.statSync(f).mode & 0o077).toBe(0);
    expect(() => log.append(/** @type {any} */ ({ kind: 'note', evaluator_visible: true }))).toThrow(/visible_to/);
    expect(() => log.append(/** @type {any} */ ({ kind: 'note', visible_to: [] }))).toThrow(/evaluator_visible/);
    expect(() => log.append({ kind: 'gossip', visible_to: [], evaluator_visible: false })).toThrow(/kind/);
    log.append({ kind: 'note', visible_to: [], evaluator_visible: false, text_ref: a });
    // A half-written last line (a crash mid-write) does not break reading.
    fs.appendFileSync(log.file, '{"kind": "no');
    expect(log.all()).toHaveLength(1);
    expect(fs.readFileSync(log.file, 'utf8')).not.toContain('case text');
  });
});
