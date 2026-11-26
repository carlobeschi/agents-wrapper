// @ts-check
// runner/adapters.js and runner/structured.js: the real providers' request and
// reply shapes, against a stand-in server on 127.0.0.1. Nothing reaches a
// real provider; the keys are made up and must never appear in a run folder.
const { test, expect } = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { realAdapters, missingKeys } = require('../runner/adapters');
const { ProviderError, fakeProvider } = require('../runner/providers');
const { EventLog } = require('../runner/events');
const { Ledger } = require('../runner/budget');
const { callModel } = require('../runner/call');
const { callStructured, validate, StructuredError } = require('../runner/structured');
const { runStudy } = require('../runner/run');

const KEYS = { ANTHROPIC_API_KEY: 'sk-ant-test-111', OPENAI_API_KEY: 'sk-oai-test-222', GEMINI_API_KEY: 'gm-test-333', OPENROUTER_API_KEY: 'sk-or-test-444' };

/** A server that answers each request with the next scripted reply. */
async function standIn(replies) {
  const seen = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      const r = replies[Math.min(n++, replies.length - 1)];
      res.writeHead(r.status || 200, { 'content-type': 'application/json', ...(r.headers || {}) });
      res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', () => r(null)));
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  return { seen, base, close: () => server.close() };
}

const envFor = (provider, base) => ({ ...KEYS, [`RUNNER_${provider.toUpperCase()}_BASE`]: base });
const req = { model: 'm-1', max_output_tokens: 256, seed: 7, messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hello?' }] };

test('anthropic: key in x-api-key, system apart, text blocks only, usage and stop reasons mapped', async () => {
  const s = await standIn([
    { body: { id: 'msg_1', model: 'claude-x', stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 4 },
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Hi' }, { type: 'text', text: '!' }] }, headers: { 'request-id': 'req_abc' } },
    { body: { id: 'msg_2', model: 'claude-x', stop_reason: 'max_tokens', usage: { input_tokens: 11, output_tokens: 256 }, content: [{ type: 'text', text: 'Hi, so' }] } },
    { body: { id: 'msg_3', model: 'claude-x', stop_reason: 'refusal', usage: { input_tokens: 11, output_tokens: 0 }, content: [] } },
  ]);
  try {
    const a = realAdapters(envFor('anthropic', s.base)).anthropic;
    const r = await a(req);
    expect(r).toMatchObject({ text: 'Hi!', stop: 'complete', input_tokens: 11, output_tokens: 4, cost_usd: null, model_returned: 'claude-x', request_id: 'req_abc', seed_sent: false });
    expect(JSON.parse(r.raw).content[0].type).toBe('thinking');
    expect(s.seen[0].url).toBe('/messages');
    expect(s.seen[0].headers['x-api-key']).toBe(KEYS.ANTHROPIC_API_KEY);
    expect(s.seen[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(s.seen[0].body).toEqual({ model: 'm-1', max_tokens: 256, system: 'Be brief.', messages: [{ role: 'user', content: 'Hello?' }] });
    expect((await a(req)).stop).toBe('length');
    expect((await a(req)).stop).toBe('refusal');
  } finally { s.close(); }
});

test('openai: bearer key, seed and max_completion_tokens sent, refusal and length mapped', async () => {
  const s = await standIn([
    { body: { id: 'c1', model: 'gpt-x-2026', choices: [{ finish_reason: 'stop', message: { content: 'Hi' } }], usage: { prompt_tokens: 9, completion_tokens: 2 } } },
    { body: { id: 'c2', model: 'gpt-x-2026', choices: [{ finish_reason: 'length', message: { content: 'Hi th' } }], usage: { prompt_tokens: 9, completion_tokens: 256 } } },
    { body: { id: 'c3', model: 'gpt-x-2026', choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'I cannot help with that.' } }], usage: { prompt_tokens: 9, completion_tokens: 6 } } },
  ]);
  try {
    const a = realAdapters(envFor('openai', s.base)).openai;
    expect(await a(req)).toMatchObject({ text: 'Hi', stop: 'complete', input_tokens: 9, output_tokens: 2, model_returned: 'gpt-x-2026', seed_sent: true });
    expect(s.seen[0].headers.authorization).toBe(`Bearer ${KEYS.OPENAI_API_KEY}`);
    expect(s.seen[0].body).toEqual({ model: 'm-1', messages: req.messages, max_completion_tokens: 256, seed: 7 });
    expect((await a(req)).stop).toBe('length');
    expect(await a(req)).toMatchObject({ stop: 'refusal', text: 'I cannot help with that.' });
  } finally { s.close(); }
});

test('openrouter: reported cost kept; an error inside a 200 reply is an error', async () => {
  const s = await standIn([
    { body: { id: 'o1', model: 'deepseek/x', choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: { prompt_tokens: 5, completion_tokens: 1, cost: 0.00042 } } },
    { body: { error: { code: 429, message: 'slow down' } } },
  ]);
  try {
    const a = realAdapters(envFor('openrouter', s.base)).openrouter;
    expect(await a(req)).toMatchObject({ text: 'ok', cost_usd: 0.00042 });
    expect(s.seen[0].body).toMatchObject({ max_tokens: 256, usage: { include: true }, seed: 7 });
    await expect(a(req)).rejects.toMatchObject({ kind: 'rate_limit' });
  } finally { s.close(); }
});

test('google: key in x-goog-api-key, thinking counted as output and left out of the text, blocks mapped', async () => {
  const s = await standIn([
    { body: { responseId: 'g1', modelVersion: 'gemini-x-001', usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, thoughtsTokenCount: 40 },
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'thinking...', thought: true }, { text: 'Hi' }] } }] } },
    { body: { usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 256 }, candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'Hi th' }] } }] } },
    { body: { promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 12 } } },
  ]);
  try {
    const a = realAdapters(envFor('google', s.base)).google;
    expect(await a(req)).toMatchObject({ text: 'Hi', stop: 'complete', input_tokens: 12, output_tokens: 43, model_returned: 'gemini-x-001', seed_sent: true });
    expect(s.seen[0].url).toBe('/models/m-1:generateContent');
    expect(s.seen[0].headers['x-goog-api-key']).toBe(KEYS.GEMINI_API_KEY);
    expect(s.seen[0].body).toEqual({ systemInstruction: { parts: [{ text: 'Be brief.' }] }, contents: [{ role: 'user', parts: [{ text: 'Hello?' }] }],
      generationConfig: { maxOutputTokens: 256, seed: 7 } });
    expect((await a(req)).stop).toBe('length');
    expect((await a(req)).stop).toBe('refusal');
  } finally { s.close(); }
});

test('HTTP errors become the same kinds everywhere, with retry-after kept', async () => {
  const s = await standIn([
    { status: 429, body: { error: { message: 'rate' } }, headers: { 'retry-after': '3' } },
    { status: 529, body: { error: { type: 'overloaded_error' } } },
    { status: 401, body: { error: { message: 'bad key' } } },
    { status: 400, body: { error: { message: 'bad field' } } },
    { status: 200, body: '<html>not json</html>' },
    { status: 200, body: { id: 'x', content: 'not a list' } },
  ]);
  try {
    const a = realAdapters(envFor('anthropic', s.base)).anthropic;
    const kinds = [];
    for (let i = 0; i < 6; i++) { const e = await a(req).catch(x => x); expect(e).toBeInstanceOf(ProviderError); kinds.push([e.kind, e.retryable, e.retry_after_ms]); }
    expect(kinds).toEqual([['rate_limit', true, 3000], ['server', true, null], ['auth', false, null], ['bad_request', false, null], ['malformed', true, null], ['malformed', true, null]]);
  } finally { s.close(); }
});

test('keys go only to the official endpoints: another base is refused unless it is this computer', () => {
  expect(() => realAdapters({ ...KEYS, RUNNER_OPENAI_BASE: 'https://example.com/v1' })).toThrow(/may only point at this computer/);
  expect(() => realAdapters({ ...KEYS, RUNNER_ANTHROPIC_BASE: 'http://localhost:9/v1' })).not.toThrow();
  expect(missingKeys(['anthropic', 'google', 'fake'], { GOOGLE_API_KEY: 'x' })).toEqual(['ANTHROPIC_API_KEY']);
});

test('a missing key fails at once, is not retried and costs nothing', async () => {
  const a = realAdapters({}).anthropic;
  await expect(a(req)).rejects.toMatchObject({ kind: 'auth', retryable: false, billed: false, message: 'ANTHROPIC_API_KEY is not set' });
});

test('a full run through the stand-in servers leaves no key anywhere in the run folder', async () => {
  const marker = (b) => (/starts with "([^"]+)" followed by your final answer/.exec(b.messages.map(m => m.content).join('\n')) || [])[1];
  const ant = await standIn([{ body: { id: 'm', model: 'claude-x', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'FINAL RECOMMENDATION: cut prices' }] } }]);
  const oai = await standIn([{ body: { id: 'c', model: 'gpt-x', choices: [{ finish_reason: 'stop', message: { content: 'Analysis: prices.' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } }]);
  try {
    const study = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'runner', 'sample-fake.json'), 'utf8'));
    study.cases = [study.cases[0]];
    study.conditions = [{ id: 'real', pattern: 'experts_moderator', seats: { expert: 'openai:gpt-x', moderator: 'anthropic:claude-x' } }];
    study.prices = { 'openai:gpt-x': { in_per_mtok: 1, out_per_mtok: 4, as_of: '2026-11-26' }, 'anthropic:claude-x': { in_per_mtok: 4, out_per_mtok: 20, as_of: '2026-11-26' } };
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-real-')), 'run');
    const env = { ...KEYS, RUNNER_ANTHROPIC_BASE: ant.base, RUNNER_OPENAI_BASE: oai.base };
    await runStudy({ study, out, adapters: realAdapters(env), sleep: async () => {} });
    const st = JSON.parse(fs.readFileSync(path.join(out, 'state.json'), 'utf8'));
    expect(st.sessions['bakery--real--r1'].outcome.status).toBe('complete');
    expect(marker(ant.seen[0].body)).toBe('FINAL RECOMMENDATION:');
    const all = [];
    const walk = d => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else all.push(fs.readFileSync(p, 'utf8')); } };
    walk(out);
    expect(all.length).toBeGreaterThan(5);
    for (const text of all) for (const k of Object.values(KEYS)) expect(text).not.toContain(k);
    // Cost computed from the reported tokens at the study's prices: 10 in + 5 out each.
    const t = new Ledger({ file: path.join(out, 'ledger.jsonl'), run_usd: 1, readonly: true }).totals();
    expect(t).toMatchObject({ computed_usd: (10 * 1 + 5 * 4 + 10 * 4 + 5 * 20) / 1e6, estimated_usd: 0 });
  } finally { ant.close(); oai.close(); }
});

test.describe('structured replies', () => {
  const schema = { type: 'object', required: ['score', 'why'], additionalProperties: false,
    properties: { score: { type: 'integer', minimum: 1, maximum: 10 }, why: { type: 'string', minLength: 3 } } };
  function rig(steps) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-st-'));
    const log = new EventLog(dir);
    const ledger = new Ledger({ file: path.join(dir, 'ledger.jsonl'), run_usd: 1 });
    const fake = fakeProvider({ j: steps });
    const go = (tries) => callStructured({ log, ledger, adapters: { fake: fake.adapter }, session_id: 's', role: 'judge', seat: 'judge#1', model: 'fake:j',
      messages: [{ role: 'user', content: 'Score it.' }], prompt_version: 'v1', max_output_tokens: 100, timeout_s: 5, retries: 0,
      reply_visible_to: [], evaluator_visible: true, schema, tries, sleep: async () => {} });
    return { log, fake, go };
  }

  test('the schema checker says what is wrong', () => {
    expect(validate({ score: 11, why: 'okay', extra: 1 }, schema)).toEqual(['$.score: should be at most 10', '$.extra: not allowed']);
    expect(validate({ score: 2.5 }, schema)).toEqual(['$.why: missing', '$.score: should be integer']);
    expect(validate({ score: 7, why: 'good' }, schema)).toEqual([]);
  });

  test('invalid, then truncated, then valid: three calls, each recorded, the reason given back', async () => {
    const { log, fake, go } = rig([{ text: '{"score": 12, "why": "great"}' }, { text: '{"score": 7, "wh', stop: 'length' }, { text: '```json\n{"score": 7, "why": "solid"}\n```' }]);
    const r = await go(3);
    expect(r).toMatchObject({ value: { score: 7, why: 'solid' }, tries: 3 });
    expect(fake.seen).toHaveLength(3);
    expect(fake.seen[0].messages[0].content).toContain('matching this JSON schema');
    expect(fake.seen[1].messages[0].content).toContain('$.score: should be at most 10');
    expect(fake.seen[2].messages[0].content).toContain('cut off by the length limit');
    const checks = log.all().filter(e => e.what === 'structured check');
    expect(checks.map(c => c.valid)).toEqual([false, false, true]);
    expect(log.all().filter(e => e.kind === 'call')).toHaveLength(3);
  });

  test('a truncated reply is never repaired into a valid one, and the tries are bounded', async () => {
    const { fake, go } = rig([{ text: '{"score": 7, "why": "fine"}', stop: 'length' }, { text: '{"score": 7, "why": "fine"}', stop: 'length' }]);
    const e = await go(2).catch(x => x);
    expect(e).toBeInstanceOf(StructuredError);
    expect(e.tries.map(t => t.problems)).toEqual([['cut off by the length limit'], ['cut off by the length limit']]);
    expect(fake.seen).toHaveLength(2);
  });
});

test('one call through a real adapter records the model that answered and whether a seed was sent', async () => {
  const s = await standIn([{ body: { id: 'c', model: 'gpt-x-2026-11-01', choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } } }]);
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-one-'));
    const log = new EventLog(dir);
    const ledger = new Ledger({ file: path.join(dir, 'ledger.jsonl'), run_usd: 1, prices: { 'openai:gpt-x': { in_per_mtok: 1, out_per_mtok: 1, as_of: '2026-11-26' } } });
    await callModel({ log, ledger, adapters: realAdapters(envFor('openai', s.base)), session_id: 's', role: 'expert', seat: 'expert#1', model: 'openai:gpt-x',
      messages: [{ role: 'user', content: 'hi' }], prompt_version: 'v1', max_output_tokens: 10, timeout_s: 5, retries: 0, seed: 3, reply_visible_to: [], evaluator_visible: true });
    expect(log.all().find(e => e.kind === 'reply')).toMatchObject({ model: 'openai:gpt-x', model_returned: 'gpt-x-2026-11-01', seed_sent: true, cost_basis: 'computed' });
  } finally { s.close(); }
});
