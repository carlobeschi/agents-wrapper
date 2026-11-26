// @ts-check
// One model call, the way the runner always makes it: reserve the worst case
// in the shared ledger, record exactly what was sent, call with a time limit,
// record exactly what came back, settle the cost, and retry a bounded number
// of times on failures that may pass (rate limit, timeout, server error,
// malformed reply). Every attempt has its own attempt_id, its own events and
// its own charge; nothing is retried silently.
//
// A reply cut by the output limit comes back with truncated: true. It is kept
// and recorded as it is; this function never retries it into a complete one
// and never marks it complete (the session decides what to do with it).

const { newId } = require('./events');
const { BudgetError } = require('./budget');
const { ProviderError } = require('./providers');
const { providerOf } = require('./study');

const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * @param {{
 *   log: import('./events').EventLog, ledger: import('./budget').Ledger,
 *   adapters: Record<string, (req: any, opts: { signal: AbortSignal }) => Promise<any>>,
 *   session_id: string, role: string, seat: string, model: string,
 *   messages: { role: 'system'|'user'|'assistant', content: string }[],
 *   prompt_version: string, max_output_tokens: number, timeout_s: number, retries: number,
 *   seed?: number|null, temperature?: number|null, parent_id?: string|null, json_mode?: boolean,
 *   reply_visible_to: string[], evaluator_visible: boolean,
 *   backoff_ms?: number, sleep?: (ms: number) => Promise<any>
 * }} o
 */
async function callModel(o) {
  const provider = providerOf(o.model);
  const name = o.model.slice(provider.length + 1);
  const adapter = o.adapters[provider];
  if (!adapter) throw new Error(`no adapter for provider "${provider}"`);
  const sleep = o.sleep || sleepMs;
  const backoff = o.backoff_ms ?? 1000;
  const shown = JSON.stringify(o.messages);
  const prompt_ref = o.log.put(shown);
  const attempts = [];
  let parent = o.parent_id ?? null;

  for (let n = 0; n <= o.retries; n++) {
    const attempt_id = newId('att');
    const base = { session_id: o.session_id, attempt_id, role: o.role };
    let reservation;
    try {
      reservation = o.ledger.reserve({ session_id: o.session_id, attempt_id, model: o.model, input_chars: shown.length, max_output_tokens: o.max_output_tokens });
    } catch (e) {
      if (e instanceof BudgetError) {
        o.log.append({ ...base, kind: 'budget', parent_id: parent, visible_to: [], evaluator_visible: true, refused: true, scope: e.scope, message: e.message, model: o.model });
      }
      throw e;
    }
    const call = o.log.append({ ...base, kind: 'call', parent_id: parent, visible_to: [], evaluator_visible: false,
      seat: o.seat, provider, model: o.model, prompt_version: o.prompt_version, prompt_ref, max_output_tokens: o.max_output_tokens,
      seed: o.seed ?? null, temperature: o.temperature ?? null, json_mode: !!o.json_mode, attempt: n + 1, reserved_usd: reservation.usd, reservation_id: reservation.reservation_id });

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), o.timeout_s * 1000);
    const started = Date.now();
    try {
      const req = { model: name, messages: o.messages, max_output_tokens: o.max_output_tokens, ...(o.seed != null ? { seed: o.seed } : {}), ...(o.temperature != null ? { temperature: o.temperature } : {}), ...(o.json_mode ? { json_mode: true } : {}) };
      const race = new Promise((_, reject) => ctl.signal.addEventListener('abort', () => reject(new ProviderError('timeout', `no reply in ${o.timeout_s} s`)), { once: true }));
      const r = await Promise.race([adapter(req, { signal: ctl.signal }), race]);
      clearTimeout(timer);
      const cost = o.ledger.settle(reservation.reservation_id, { input_tokens: r.input_tokens, output_tokens: r.output_tokens, cost_usd: r.cost_usd });
      const reply = o.log.append({ ...base, kind: 'reply', parent_id: call.event_id, visible_to: o.reply_visible_to, evaluator_visible: o.evaluator_visible,
        seat: o.seat, model: o.model, model_returned: r.model_returned, request_id: r.request_id, seed_sent: r.seed_sent, json_mode_sent: r.json_mode_sent ?? null,
        text_ref: o.log.put(r.text), raw_ref: o.log.put(r.raw), stop: r.stop, truncated: r.stop === 'length',
        input_tokens: r.input_tokens, output_tokens: r.output_tokens, cost_usd: cost.usd, cost_basis: cost.basis, ms: Date.now() - started });
      attempts.push({ attempt_id, ok: true });
      return { ...r, truncated: r.stop === 'length', attempt_id, event_id: reply.event_id, attempts, cost };
    } catch (e) {
      clearTimeout(timer);
      const err = e instanceof ProviderError ? e : new ProviderError('server', String(e && e.message || e));
      const cost = o.ledger.settle(reservation.reservation_id, { billed: err.billed ? undefined : false });
      const ev = o.log.append({ ...base, kind: 'error', parent_id: call.event_id, visible_to: [], evaluator_visible: true,
        seat: o.seat, model: o.model, error: err.kind, message: err.message, status: err.status, retryable: err.retryable,
        raw_ref: err.raw != null ? o.log.put(err.raw) : null, cost_usd: cost.usd, cost_basis: cost.basis, ms: Date.now() - started });
      attempts.push({ attempt_id, ok: false, error: err.kind });
      if (!err.retryable || n === o.retries) {
        err.attempts = attempts;
        throw err;
      }
      const wait = err.retry_after_ms ?? backoff * 2 ** n;
      o.log.append({ ...base, kind: 'retry', parent_id: ev.event_id, visible_to: [], evaluator_visible: true, after: err.kind, wait_ms: wait, next_attempt: n + 2 });
      parent = ev.event_id;
      await sleep(wait);
    }
  }
  throw new Error('unreachable');
}

module.exports = { callModel };
