// @ts-check
// One session: one case, one condition, one repeat, played turn by turn.
//
// - solo: the one participant gets the task (and what else its role may
//   see) and must close with the case's final-answer line.
// - experts_moderator: every expert writes an analysis alone, at the same
//   time. With peer consultation on, an expert may write one line
//   "ASK PEER: <question>"; the next expert answers it once, and the asker
//   revises. The moderator then reads the analyses (shuffled with the seed,
//   labelled "Expert 1", "Expert 2"...) and must close with the final line.
//
// A session is complete only when the closing reply has the final-answer
// line, or ended early when it says "EARLY END: <reason>". A reply cut by the
// output limit never counts, even if the line is in it. When the turns run
// out, the session is incomplete with reason turn_limit, and its last reply
// is kept. Nothing is ever turned into a complete answer that was not one.

const { callModel } = require('./call');
const { BudgetError } = require('./budget');
const { ProviderError } = require('./providers');
const { view, finalOf, shuffled, SecretLeak } = require('./view');

const label = (kind, i, n) => n === 1 && kind !== 'expert' ? kind[0].toUpperCase() + kind.slice(1) : `${kind[0].toUpperCase() + kind.slice(1)} ${i + 1}`;

/** The seats of a condition: one per model, with neutral labels. @param {any} study @param {any} condition */
function seatsOf(study, condition) {
  const out = [];
  for (const [roleName, m] of Object.entries(condition.seats)) {
    const models = [m].flat();
    const role = study.roles[roleName];
    models.forEach((model, i) => out.push({ seat: `${roleName}#${i + 1}`, roleName, role, model, label: label(role.kind, i, models.length) }));
  }
  return out;
}

/**
 * @param {{ study: any, kase: any, condition: any, repeat: number, session_id: string,
 *           log: import('./events').EventLog, ledger: import('./budget').Ledger,
 *           adapters: Record<string, any>, sleep?: (ms: number) => Promise<any>, backoff_ms?: number }} o
 * status is complete, ended_early or incomplete.
 * @returns {Promise<{ status: string, reason: string|null, final: string|null,
 *           closing_text: string|null, closing_seat: string|null, turns: number }>}
 */
async function runSession(o) {
  const { study, kase, condition, session_id, log } = o;
  const seats = seatsOf(study, condition);
  const limits = study.limits;
  const marker = kase.final_answer.marker;
  let turns = 0;

  const ask = (seat, messages, reply_visible_to, parent_id = null) => callModel({
    log, ledger: o.ledger, adapters: o.adapters, session_id, role: seat.roleName, seat: seat.seat, model: seat.model, messages,
    prompt_version: seat.role.prompt_version, max_output_tokens: seat.role.max_output_tokens || limits.max_output_tokens,
    timeout_s: limits.timeout_s, retries: limits.retries, seed: study.seed ?? null, parent_id,
    reply_visible_to, evaluator_visible: true, sleep: o.sleep, backoff_ms: o.backoff_ms,
  });

  // The closing loop: the same seat asked again until it closes or turns run out.
  async function close(seat, transcript) {
    let last = null;
    for (let t = 1; t <= limits.turns; t++) {
      turns++;
      const extra = [];
      if (last) {
        extra.push(`## Your previous reply\n\n${last.text}`);
        extra.push(last.truncated ? 'That reply was cut off by the length limit. Write your final answer again, shorter.'
          : 'That reply had no final-answer line.');
      }
      const r = await ask(seat, view({ role: seat.role, roleName: seat.roleName, kase, transcript, closing: true, extra }), [], last ? last.event_id : null);
      last = r;
      if (r.truncated) continue;
      const f = finalOf(r.text, marker);
      if (f.kind === 'final') return { status: 'complete', reason: null, final: f.answer, closing_text: r.text, closing_seat: seat.seat, turns };
      if (f.kind === 'early') return { status: 'ended_early', reason: f.answer || 'no reason given', final: null, closing_text: r.text, closing_seat: seat.seat, turns };
    }
    return { status: 'incomplete', reason: last && last.truncated ? 'turn_limit (last reply cut by the length limit)' : 'turn_limit',
      final: null, closing_text: last ? last.text : null, closing_seat: seat.seat, turns };
  }

  try {
    if (condition.pattern === 'solo') {
      const seat = seats.find(s => ['candidate', 'expert'].includes(s.role.kind));
      return await close(seat, []);
    }

    // experts_moderator
    const experts = seats.filter(s => s.role.kind === 'expert');
    const moderator = seats.find(s => s.role.kind === 'moderator');
    const consult = condition.peer_consultation
      ? ['You may ask one other expert (an AI model) one question before you finish: write a line "ASK PEER: <your question>". You will get one answer and can then revise.']
      : [];
    const first = await Promise.all(experts.map(s => {
      turns++;
      return ask(s, view({ role: s.role, roleName: s.roleName, kase, extra: consult }), [moderator.seat]);
    }));
    const analyses = first.map(r => ({ text: r.text, event_id: r.event_id }));

    if (condition.peer_consultation && experts.length > 1) {
      await Promise.all(experts.map(async (s, i) => {
        const line = first[i].text.split('\n').find(l => l.trim().startsWith('ASK PEER:'));
        if (!line) return;
        const question = line.trim().slice('ASK PEER:'.length).trim();
        const peer = experts[(i + 1) % experts.length];
        turns++;
        const answer = await ask(peer, view({ role: peer.role, roleName: peer.roleName, kase,
          extra: [`## A question from another expert (an AI model)\n\n${question}\n\nAnswer it in a few sentences.`] }), [s.seat], first[i].event_id);
        turns++;
        const revised = await ask(s, view({ role: s.role, roleName: s.roleName, kase,
          extra: [`## Your first analysis\n\n${first[i].text}`, `## The answer you got\n\n${answer.text}`, 'Write your analysis again, revised as you see fit. No more questions.'] }),
          [moderator.seat], answer.event_id);
        analyses[i] = { text: revised.text, event_id: revised.event_id };
      }));
    }

    const order = shuffled(analyses.map((a, i) => i), `${study.seed ?? 0}:${session_id}`);
    const transcript = order.map((i, k) => ({ label: `Expert ${k + 1}`, text: analyses[i].text }));
    log.append({ kind: 'note', session_id, visible_to: [], evaluator_visible: true, what: 'moderator order',
      order: order.map((i, k) => ({ label: `Expert ${k + 1}`, seat: experts[i].seat, from_event: analyses[i].event_id })) });
    return await close(moderator, transcript);
  } catch (e) {
    const reason = e instanceof BudgetError ? `budget_${e.scope}`
      : e instanceof ProviderError ? `error:${e.kind}`
      : e instanceof SecretLeak ? 'secret_guard' : null;
    if (!reason) throw e;
    if (e instanceof SecretLeak) log.append({ kind: 'note', session_id, visible_to: [], evaluator_visible: true, what: 'secret guard', message: e.message });
    return { status: 'incomplete', reason, final: null, closing_text: null, closing_seat: null, turns };
  }
}

module.exports = { runSession, seatsOf };
