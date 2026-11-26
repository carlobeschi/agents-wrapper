// @ts-check
// What every provider adapter returns, whatever the vendor, and the fake
// provider the tests use. Real adapters (Anthropic, OpenAI, Google,
// OpenRouter) come in a later change; each one turns a vendor's reply into
// the same shape, and a vendor's error into the same ProviderError kinds.
//
// An adapter is: async (request, { signal }) => Result, where
//   request = { model, messages: [{ role: 'system'|'user'|'assistant', content }],
//               max_output_tokens, seed? }
//   Result  = { text, stop: 'complete'|'length'|'refusal'|'other',
//               input_tokens, output_tokens, cost_usd,   (null when the provider did not say)
//               model_returned, request_id, raw }        (raw: the reply exactly as received, a string)
// "length" means the reply was cut by the output limit: it is kept, and never
// counted as a complete answer.

/** @typedef {'rate_limit'|'timeout'|'server'|'malformed'|'auth'|'bad_request'} ErrorKind */

const RETRYABLE = ['rate_limit', 'timeout', 'server', 'malformed'];
// Errors after which nothing was billed. A timeout or a cut connection may
// have been billed, so those are settled at the full reservation.
const NOT_BILLED = ['rate_limit', 'auth', 'bad_request'];

class ProviderError extends Error {
  /**
   * @param {ErrorKind} kind
   * @param {string} message
   * @param {{ retry_after_ms?: number|null, raw?: string|null, status?: number|null }} [extra]
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryable = RETRYABLE.includes(kind);
    this.billed = !NOT_BILLED.includes(kind);
    this.retry_after_ms = extra.retry_after_ms ?? null;
    this.raw = extra.raw ?? null;
    this.status = extra.status ?? null;
    /** @type {{ attempt_id: string, ok: boolean, error?: string }[]} the attempts made, filled in by callModel */
    this.attempts = [];
  }
}

const STOPS = ['complete', 'length', 'refusal', 'other'];

/**
 * Checks an adapter's result, so a broken adapter fails loudly instead of
 * passing on a half-filled reply.
 * @param {any} r
 */
function checkResult(r) {
  if (!r || typeof r !== 'object') throw new ProviderError('malformed', 'adapter returned nothing');
  if (typeof r.text !== 'string') throw new ProviderError('malformed', 'reply has no text', { raw: r.raw ?? null });
  if (!STOPS.includes(r.stop)) throw new ProviderError('malformed', `reply stop "${r.stop}" is not one of ${STOPS.join(', ')}`, { raw: r.raw ?? null });
  const n = (x) => x === null || x === undefined || (typeof x === 'number' && Number.isFinite(x) && x >= 0);
  if (!n(r.input_tokens) || !n(r.output_tokens) || !n(r.cost_usd)) throw new ProviderError('malformed', 'usage is not a number or null', { raw: r.raw ?? null });
  return {
    text: r.text, stop: r.stop,
    input_tokens: r.input_tokens ?? null, output_tokens: r.output_tokens ?? null, cost_usd: r.cost_usd ?? null,
    model_returned: r.model_returned ?? null, request_id: r.request_id ?? null, raw: typeof r.raw === 'string' ? r.raw : JSON.stringify(r.raw ?? null),
  };
}

/**
 * The fake provider: plays a script, records every request. Never touches
 * the network. A step is one reply or one failure:
 *   { text, stop?, input_tokens?, output_tokens?, cost_usd?, delay_ms? }
 *   { error: 'rate_limit'|'timeout'|'server'|'auth'|'bad_request', retry_after_ms?, delay_ms? }
 *   { malformed: '<raw body that is not a reply>' }
 *   { hang: true }   (never answers: the caller's timeout must stop it)
 * A script is a list of steps per model name, or a function (request, n) => step.
 * @param {Record<string, any[]> | ((req: any, n: number) => any)} script
 */
function fakeProvider(script) {
  /** @type {any[]} */
  const seen = [];
  const counts = new Map();
  /** @param {any} req @param {{ signal?: AbortSignal }} [opts] */
  async function adapter(req, { signal } = {}) {
    const n = counts.get(req.model) || 0;
    counts.set(req.model, n + 1);
    seen.push(JSON.parse(JSON.stringify(req)));
    const step = typeof script === 'function' ? script(req, n)
      : (script[req.model] || script['*'] || [])[n];
    if (!step) throw new ProviderError('bad_request', `fake: no step ${n + 1} for ${req.model}`);
    const wait = (ms) => new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(new ProviderError('timeout', 'fake: aborted')); }, { once: true });
    });
    if (step.hang) await wait(1e9);
    if (step.delay_ms) await wait(step.delay_ms);
    if (step.error) throw new ProviderError(step.error, `fake: ${step.error}`, { retry_after_ms: step.retry_after_ms ?? null, raw: JSON.stringify({ error: step.error }) });
    if (step.malformed !== undefined) {
      let j; try { j = JSON.parse(step.malformed); } catch { throw new ProviderError('malformed', 'fake: reply is not JSON', { raw: step.malformed }); }
      return checkResult({ ...j, raw: step.malformed });
    }
    const text = typeof step.text === 'function' ? step.text(req) : step.text;
    return checkResult({
      text, stop: step.stop || 'complete',
      input_tokens: step.input_tokens === undefined ? 100 : step.input_tokens,
      output_tokens: step.output_tokens === undefined ? 50 : step.output_tokens,
      cost_usd: step.cost_usd === undefined ? null : step.cost_usd,
      model_returned: `fake-${req.model}`, request_id: `fake-req-${seen.length}`,
      raw: JSON.stringify({ text, stop: step.stop || 'complete' }),
    });
  }
  return { adapter, seen };
}

/**
 * The fake used by `node runner.js run` for "fake:" models: a short analysis,
 * and the final-answer line when the prompt asks for one. RUNNER_FAKE_DELAY_MS
 * slows every reply (for interruption tests).
 * @param {any} req
 */
function defaultFakeStep(req) {
  const prompt = req.messages.map(m => m.content).join('\n');
  const m = /starts with "([^"]+)" followed by your final answer/.exec(prompt);
  const text = m ? `Having read everything, the main cause is clear.\n${m[1]} Act on the main cause first.`
    : `Analysis (${req.model}): the main cause is most likely the change listed first in the materials.`;
  return { text, delay_ms: Number(process.env.RUNNER_FAKE_DELAY_MS || 0) };
}

module.exports = { ProviderError, checkResult, fakeProvider, defaultFakeStep, RETRYABLE };
