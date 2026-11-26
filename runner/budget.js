// @ts-check
// The shared budget of a run: one ledger for every session, every parallel
// call and every retry. Money, in US dollars, from the dated price table in
// the study file.
//
// - Before a call, its worst case is RESERVED: the prompt's tokens (estimated
//   high, one token per 3 characters) at the input price, plus the call's
//   whole output allowance at the output price. A call whose reservation does
//   not fit under the run's cap (or its session's) is not made.
// - After the call the reservation is SETTLED: at the cost the provider
//   reported if it did ("reported"), else from the tokens it reported and the
//   price table ("computed"), else at the full reservation ("estimated"). An
//   unknown cost is never taken as zero, and the report shows how much of the
//   total is estimated.
// - A failed call that may still have been billed (a timeout, a cut
//   connection) is settled "estimated" at its full reservation too.
// The ledger is an append-only ledger.jsonl in the run folder, so a resumed
// run starts from what was really spent. A reservation that was never settled
// (the process stopped mid-call) counts as spent in full, "estimated".

const fs = require('fs');
const { newId } = require('./events');
const { providerOf } = require('./study');

class BudgetError extends Error {
  /** @param {string} message @param {'run'|'session'|'price'} scope */
  constructor(message, scope) { super(message); this.name = 'BudgetError'; this.scope = scope; }
}

const tokensFor = (chars) => Math.ceil(Math.max(0, chars) / 3);
const round = (x) => Math.round(x * 1e8) / 1e8;

class Ledger {
  /**
   * @param {{ file: string, run_usd: number, session_usd?: number|null,
   *           prices?: Record<string, { in_per_mtok: number, out_per_mtok: number, as_of?: string }>, readonly?: boolean }} opts
   *   readonly: only read the ledger (a report on a run that may still be going); reserving is refused.
   */
  constructor({ file, run_usd, session_usd = null, prices = {}, readonly = false }) {
    this.file = file;
    this.readonly = readonly;
    this.run_usd = run_usd;
    this.session_usd = session_usd;
    this.prices = prices;
    /** @type {Map<string, { session_id: string, usd: number, model: string, settled: boolean }>} */
    this.open = new Map();
    /** charged money by session and basis */
    this.charged = [];
    this.replay();
  }

  replay() {
    if (!fs.existsSync(this.file)) return;
    const res = new Map();
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.op === 'reserve') res.set(r.reservation_id, r);
      if (r.op === 'settle') {
        res.delete(r.reservation_id);
        this.charged.push({ session_id: r.session_id, usd: r.usd, basis: r.basis });
      }
    }
    // Reserved before a stop and never settled: count it in full. Read-only,
    // it is shown as held instead (the call may still be running).
    for (const r of res.values()) {
      if (this.readonly) { this.open.set(r.reservation_id, { session_id: r.session_id, usd: r.usd, model: r.model, settled: false }); continue; }
      const row = { op: 'settle', reservation_id: r.reservation_id, session_id: r.session_id, usd: r.usd, basis: 'estimated', why: 'never settled (stopped mid-call)' };
      this.write(row);
      this.charged.push({ session_id: r.session_id, usd: r.usd, basis: 'estimated' });
    }
  }

  /** @param {object} row */
  write(row) { fs.appendFileSync(this.file, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n', { mode: 0o600 }); }

  /** @param {string} model */
  priceOf(model) {
    const p = this.prices[model];
    if (p) return p;
    if (providerOf(model) === 'fake') return { in_per_mtok: 0, out_per_mtok: 0 };
    return null;
  }

  /** @param {string} model @param {number} inputChars @param {number} maxOutputTokens */
  worstCase(model, inputChars, maxOutputTokens) {
    const p = this.priceOf(model);
    if (!p) throw new BudgetError(`no price for ${model}: add it to "prices" in the study`, 'price');
    return round((tokensFor(inputChars) * p.in_per_mtok + maxOutputTokens * p.out_per_mtok) / 1e6);
  }

  /** @param {string} [session_id] money spent or held so far */
  used(session_id) {
    const pick = (/** @type {{session_id: string}} */ x) => session_id === undefined || x.session_id === session_id;
    const spent = this.charged.filter(pick).reduce((s, c) => s + c.usd, 0);
    const held = [...this.open.values()].filter(pick).reduce((s, r) => s + r.usd, 0);
    return round(spent + held);
  }

  /**
   * Holds the worst case of one call, or throws BudgetError if it does not fit.
   * Synchronous, so parallel calls in this process cannot both take the last dollar.
   * @param {{ session_id: string, attempt_id: string, model: string, input_chars: number, max_output_tokens: number }} a
   */
  reserve(a) {
    if (this.readonly) throw new Error('this ledger was opened read-only');
    const usd = this.worstCase(a.model, a.input_chars, a.max_output_tokens);
    if (this.used() + usd > this.run_usd + 1e-12) {
      throw new BudgetError(`run budget: $${this.used().toFixed(4)} used of $${this.run_usd}, this call may cost up to $${usd.toFixed(4)}`, 'run');
    }
    if (this.session_usd != null && this.used(a.session_id) + usd > this.session_usd + 1e-12) {
      throw new BudgetError(`session budget: $${this.used(a.session_id).toFixed(4)} used of $${this.session_usd}, this call may cost up to $${usd.toFixed(4)}`, 'session');
    }
    const reservation_id = newId('res');
    this.open.set(reservation_id, { session_id: a.session_id, usd, model: a.model, settled: false });
    this.write({ op: 'reserve', reservation_id, session_id: a.session_id, attempt_id: a.attempt_id, model: a.model, usd });
    return { reservation_id, usd };
  }

  /**
   * Replaces a reservation by what the call cost.
   * @param {string} reservation_id
   * @param {{ input_tokens?: number|null, output_tokens?: number|null, cost_usd?: number|null, billed?: boolean }} usage
   *   billed: false only when the call surely cost nothing (refused before sending, or the provider said so).
   */
  settle(reservation_id, usage = {}) {
    const r = this.open.get(reservation_id);
    if (!r) throw new Error(`no open reservation ${reservation_id}`);
    this.open.delete(reservation_id);
    let usd, basis;
    const p = this.priceOf(r.model);
    if (usage.billed === false) { usd = 0; basis = 'reported'; }
    else if (typeof usage.cost_usd === 'number' && Number.isFinite(usage.cost_usd)) { usd = usage.cost_usd; basis = 'reported'; }
    else if (p && Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens)) {
      usd = round((Number(usage.input_tokens) * p.in_per_mtok + Number(usage.output_tokens) * p.out_per_mtok) / 1e6); basis = 'computed';
    } else { usd = r.usd; basis = 'estimated'; }
    this.write({ op: 'settle', reservation_id, session_id: r.session_id, usd, basis, reserved_usd: r.usd });
    this.charged.push({ session_id: r.session_id, usd, basis });
    return { usd, basis, reserved_usd: r.usd };
  }

  /** @param {string} [session_id] */
  totals(session_id) {
    const pick = (/** @type {{session_id: string}} */ x) => session_id === undefined || x.session_id === session_id;
    const by = (basis) => round(this.charged.filter(c => pick(c) && c.basis === basis).reduce((s, c) => s + c.usd, 0));
    return { reported_usd: by('reported'), computed_usd: by('computed'), estimated_usd: by('estimated'),
      held_usd: round([...this.open.values()].filter(pick).reduce((s, r) => s + r.usd, 0)), total_usd: this.used(session_id), cap_usd: session_id === undefined ? this.run_usd : this.session_usd };
  }
}

module.exports = { Ledger, BudgetError, tokensFor };
