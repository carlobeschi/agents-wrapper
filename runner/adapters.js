// @ts-check
// The real providers, called directly over HTTPS with fetch (no vendor
// libraries), so the reply is kept exactly as it arrived. Each adapter turns
// its vendor's reply into the shape in providers.js and its errors into the
// same ProviderError kinds.
//
//   anthropic   https://api.anthropic.com/v1/messages              ANTHROPIC_API_KEY
//   openai      https://api.openai.com/v1/chat/completions         OPENAI_API_KEY
//   google      https://generativelanguage.googleapis.com/v1beta   GEMINI_API_KEY (or GOOGLE_API_KEY)
//   openrouter  https://openrouter.ai/api/v1/chat/completions      OPENROUTER_API_KEY
//
// Keys come from the environment only (on the Mac, filled from the Keychain
// by the shell that starts the run). They are sent only to the endpoints
// above: a different base (RUNNER_<PROVIDER>_BASE) is accepted only on this
// computer (127.0.0.1 or localhost), which is what the tests use. Keys are
// never written to the record; replies are, as received.
//
// Seeds: OpenAI, Google and OpenRouter are sent the study's seed (honoured on
// a best-effort basis, or not at all, depending on the model); Anthropic has no
// seed. Each reply records whether a seed was sent.

const { ProviderError, checkResult } = require('./providers');

const ENDPOINTS = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  openrouter: 'https://openrouter.ai/api/v1',
};
const KEYS = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
};

/** @param {string} provider @param {NodeJS.ProcessEnv} env */
function baseOf(provider, env) {
  const override = env[`RUNNER_${provider.toUpperCase()}_BASE`];
  if (!override) return ENDPOINTS[provider];
  let u;
  try { u = new URL(override); } catch { throw new Error(`RUNNER_${provider.toUpperCase()}_BASE is not a URL`); }
  if (!['127.0.0.1', 'localhost'].includes(u.hostname)) {
    throw new Error(`RUNNER_${provider.toUpperCase()}_BASE may only point at this computer; keys are sent to ${ENDPOINTS[provider]} and nowhere else`);
  }
  return override.replace(/\/$/, '');
}

/** @param {string} provider @param {NodeJS.ProcessEnv} env */
const keyOf = (provider, env) => KEYS[provider].map(k => env[k]).find(Boolean) || null;

/** Seconds or an HTTP date, to milliseconds. @param {string|null} h */
function retryAfter(h) {
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, Math.round(s * 1000));
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
}

/** An HTTP status to an error kind. @param {number} status */
function kindOf(status) {
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 403) return 'auth';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'server';
  return 'bad_request';
}

/**
 * Sends one request and returns the parsed body and the raw text.
 * @param {string} url @param {Record<string, string>} headers @param {any} body @param {AbortSignal} [signal]
 */
async function send(url, headers, body, signal) {
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  } catch (e) {
    if (signal?.aborted) throw new ProviderError('timeout', 'aborted at the time limit');
    throw new ProviderError('server', `network: ${e.cause?.code || e.message}`);
  }
  const raw = await r.text().catch(() => '');
  const request_id = r.headers.get('request-id') || r.headers.get('x-request-id') || null;
  if (!r.ok) {
    let msg = raw.slice(0, 300);
    try { const j = JSON.parse(raw); msg = j.error?.message || j.error?.type || msg; } catch {}
    // Anthropic's "overloaded" is 529: a server error that may pass.
    throw new ProviderError(kindOf(r.status), `HTTP ${r.status}: ${msg}`, { status: r.status, raw, retry_after_ms: retryAfter(r.headers.get('retry-after')) });
  }
  let j;
  try { j = JSON.parse(raw); } catch { throw new ProviderError('malformed', 'reply is not JSON', { raw, status: r.status }); }
  return { j, raw, request_id };
}

// A role's temperature, when the study sets one; otherwise the provider's default.
const temp = (req) => typeof req.temperature === 'number' ? { temperature: req.temperature } : {};
const systemText = (messages) => messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
const turns = (messages) => messages.filter(m => m.role !== 'system');

/** @param {NodeJS.ProcessEnv} env */
function anthropic(env) {
  return async (/** @type {any} */ req, /** @type {{ signal?: AbortSignal }} */ { signal } = {}) => {
    const key = keyOf('anthropic', env);
    if (!key) throw new ProviderError('auth', 'ANTHROPIC_API_KEY is not set');
    const sys = systemText(req.messages);
    const { j, raw, request_id } = await send(`${baseOf('anthropic', env)}/messages`,
      { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      { model: req.model, max_tokens: req.max_output_tokens, ...temp(req), ...(sys ? { system: sys } : {}), messages: turns(req.messages).map(m => ({ role: m.role, content: m.content })) },
      signal);
    if (!Array.isArray(j.content)) throw new ProviderError('malformed', 'reply has no content list', { raw });
    // Only text blocks are the answer; thinking blocks are kept in raw.
    const text = j.content.filter(b => b && b.type === 'text').map(b => b.text).join('');
    const stop = { end_turn: 'complete', stop_sequence: 'complete', max_tokens: 'length', refusal: 'refusal' }[j.stop_reason] || 'other';
    return checkResult({ text, stop, input_tokens: j.usage?.input_tokens ?? null, output_tokens: j.usage?.output_tokens ?? null, cost_usd: null,
      model_returned: j.model ?? null, request_id: request_id || j.id || null, raw, seed_sent: false });
  };
}

/** OpenAI's chat completions, and OpenRouter, which speaks the same. @param {'openai'|'openrouter'} provider @param {NodeJS.ProcessEnv} env */
function chat(provider, env) {
  return async (/** @type {any} */ req, /** @type {{ signal?: AbortSignal }} */ { signal } = {}) => {
    const key = keyOf(provider, env);
    if (!key) throw new ProviderError('auth', `${KEYS[provider][0]} is not set`);
    const seed = Number.isInteger(req.seed) ? { seed: req.seed } : {};
    const body = provider === 'openai'
      ? { model: req.model, messages: req.messages, max_completion_tokens: req.max_output_tokens, ...temp(req), ...seed }
      : { model: req.model, messages: req.messages, max_tokens: req.max_output_tokens, usage: { include: true }, ...temp(req), ...seed };
    const { j, raw, request_id } = await send(`${baseOf(provider, env)}/chat/completions`, { authorization: `Bearer ${key}` }, body, signal);
    // OpenRouter can answer 200 with an error inside.
    if (j.error) throw new ProviderError(kindOf(Number(j.error.code) || 500), `error in reply: ${j.error.message || 'unknown'}`, { raw });
    const c = Array.isArray(j.choices) ? j.choices[0] : null;
    if (!c || !c.message) throw new ProviderError('malformed', 'reply has no choices', { raw });
    const refused = typeof c.message.refusal === 'string' && c.message.refusal;
    const text = typeof c.message.content === 'string' ? c.message.content : (refused || '');
    const stop = refused ? 'refusal' : { stop: 'complete', length: 'length', content_filter: 'refusal' }[c.finish_reason] || 'other';
    return checkResult({ text, stop, input_tokens: j.usage?.prompt_tokens ?? null, output_tokens: j.usage?.completion_tokens ?? null,
      cost_usd: provider === 'openrouter' && typeof j.usage?.cost === 'number' ? j.usage.cost : null,
      model_returned: j.model ?? null, request_id: request_id || j.id || null, raw, seed_sent: 'seed' in seed });
  };
}

/** @param {NodeJS.ProcessEnv} env */
function google(env) {
  return async (/** @type {any} */ req, /** @type {{ signal?: AbortSignal }} */ { signal } = {}) => {
    const key = keyOf('google', env);
    if (!key) throw new ProviderError('auth', 'GEMINI_API_KEY is not set');
    const sys = systemText(req.messages);
    const seed = Number.isInteger(req.seed) ? { seed: req.seed } : {};
    const { j, raw, request_id } = await send(`${baseOf('google', env)}/models/${encodeURIComponent(req.model)}:generateContent`, { 'x-goog-api-key': key }, {
      ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
      contents: turns(req.messages).map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: req.max_output_tokens, ...temp(req), ...seed },
    }, signal);
    const u = j.usageMetadata || {};
    // Thinking is billed as output: count it with the answer.
    const out = Number.isFinite(u.candidatesTokenCount) || Number.isFinite(u.thoughtsTokenCount) ? (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) : null;
    const base = { input_tokens: u.promptTokenCount ?? null, output_tokens: out, cost_usd: null, model_returned: j.modelVersion ?? req.model,
      request_id: request_id || j.responseId || null, raw, seed_sent: 'seed' in seed };
    if (j.promptFeedback?.blockReason && !j.candidates?.length) return checkResult({ ...base, text: '', stop: 'refusal' });
    const c = Array.isArray(j.candidates) ? j.candidates[0] : null;
    if (!c) throw new ProviderError('malformed', 'reply has no candidates', { raw });
    const text = (c.content?.parts || []).filter(p => p && typeof p.text === 'string' && !p.thought).map(p => p.text).join('');
    const stop = c.finishReason === 'STOP' ? 'complete' : c.finishReason === 'MAX_TOKENS' ? 'length'
      : ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(c.finishReason) ? 'refusal' : 'other';
    return checkResult({ ...base, text, stop });
  };
}

/**
 * The adapters for every provider, reading keys from env when called.
 * @param {NodeJS.ProcessEnv} [env]
 */
function realAdapters(env = process.env) {
  for (const p of Object.keys(ENDPOINTS)) baseOf(p, env); // refuse a bad base before any call
  return { anthropic: anthropic(env), openai: chat('openai', env), google: google(env), openrouter: chat('openrouter', env) };
}

/** Providers a study needs whose key is not set. @param {string[]} providers @param {NodeJS.ProcessEnv} [env] */
const missingKeys = (providers, env = process.env) => providers.filter(p => KEYS[p] && !keyOf(p, env)).map(p => KEYS[p][0]);

module.exports = { realAdapters, missingKeys, ENDPOINTS };
