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
// - interview (after EnterpriseBench's consulting interview): an interviewer
//   who holds the whole case talks with one candidate, one message at a
//   time; interviewer and candidate messages both count towards
//   max_messages (default 12). The interviewer opens, answers the candidate's
//   questions and asks follow-ups, as its prompt says, and ends with the end
//   token (default <|CASE_INTERVIEW_END|>). The candidate is either one model
//   or a panel: at every candidate turn each expert, alone and at the same
//   time, proposes the next reply from the dialogue so far (and what its role
//   may see), and the moderator reads the proposals (shuffled, "Expert 1"...)
//   and writes the one reply the interviewer gets. The interview is complete
//   when a candidate reply, not cut by the length limit, has the final-answer
//   line; how it ended (interviewer_end, turn_limit, candidate_early_end) is
//   recorded either way. Interviewer lines starting with the hint marker
//   (default "HINT:") are listed as hints.
//   With paper_prompts, the interviewer, candidate, experts and moderator get
//   the prompts rendered by runner/enterprisebench-prompts.js instead (the
//   interviewer's case text is the case's secret; experts and moderator get no
//   system prompt; experts are asked one after another, in a fixed order; JSON
//   replies are asked for natively where the provider can). A candidate reply
//   that is not usable JSON is replaced, as in the released code, with a fixed
//   fallback sentence: the dialogue marks it, it is counted, and it is never
//   an answer.
//
// A session is complete only when the closing reply has the final-answer
// line, or ended early when it says "EARLY END: <reason>". A reply cut by the
// output limit never counts, even if the line is in it. When the turns run
// out, the session is incomplete with reason turn_limit, and its last reply
// is kept. Nothing is ever turned into a complete answer that was not one.

const { callModel } = require('./call');
const { BudgetError } = require('./budget');
const { ProviderError } = require('./providers');
const { view, guard, finalOf, shuffled, SecretLeak } = require('./view');
const paper = require('./enterprisebench-prompts');

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
 *           closing_text: string|null, closing_seat: string|null, turns: number, ended_by?: string|null,
 *           dialogue?: { n: number, actor: string, text: string, truncated: boolean, event_id: string, fallback?: boolean }[], hints?: { n: number, text: string }[], fallbacks?: number }>}
 */
async function runSession(o) {
  const { study, kase, condition, session_id, log } = o;
  const seats = seatsOf(study, condition);
  const limits = study.limits;
  const marker = kase.final_answer.marker;
  let turns = 0;

  const ask = (seat, messages, reply_visible_to, parent_id = null, json_mode = false) => callModel({
    log, ledger: o.ledger, adapters: o.adapters, session_id, role: seat.roleName, seat: seat.seat, model: seat.model, messages,
    prompt_version: seat.role.prompt_version, max_output_tokens: seat.role.max_output_tokens || limits.max_output_tokens,
    timeout_s: limits.timeout_s, retries: limits.retries, seed: study.seed ?? null, temperature: seat.role.temperature ?? null, parent_id,
    reply_visible_to, evaluator_visible: true, sleep: o.sleep, backoff_ms: o.backoff_ms, json_mode,
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

  // The interview: one message at a time, interviewer first.
  /** @type {{ n: number, actor: string, text: string, truncated: boolean, event_id: string, fallback?: boolean }[]} */
  const dialogue = [];
  /** @type {{ n: number, text: string }[]} */
  const hints = [];
  const said = () => dialogue.length ? '## The interview so far\n\n' + dialogue.map(d => `### ${d.actor} (message ${d.n})\n\n${d.text}`).join('\n\n') : '## The interview so far\n\nNothing yet.';
  async function interview() {
    const max = condition.max_messages || 12;
    const END = condition.end_token || '<|CASE_INTERVIEW_END|>';
    const HINT = condition.hint_marker === undefined ? 'HINT:' : condition.hint_marker;
    const interviewer = seats.find(s => s.role.kind === 'interviewer');
    const candidate = seats.find(s => s.role.kind === 'candidate');
    const experts = seats.filter(s => s.role.kind === 'expert');
    const moderator = seats.find(s => s.role.kind === 'moderator');
    const facing = candidate ? [candidate.seat] : [...experts.map(s => s.seat), moderator.seat];
    const candRule = condition.candidate_marker_instruction === false ? null : `When you give your final recommendation, put it after a line that starts with "${marker}". If you cannot go on, write a line that starts with "EARLY END:" and say why.`;
    let ended_by = 'turn_limit';
    let last = null;
    while (dialogue.length < max) {
      turns++;
      const ivExtra = [said(), `You are the interviewer. Write your next message to the candidate. When the interview is over, write ${END}.`
        + (HINT ? ` If you give the candidate a hint, put it on a line that starts with "${HINT}".` : '')];
      const paperHistory = dialogue.map(d => ({ role: d.actor.toLowerCase(), content: d.text }));
      const ivMessages = condition.paper_prompts ? [
        { role: 'system', content: interviewer.role.prompt },
        { role: 'user', content: paper.interviewerUser(kase.secret, kase.paper_opening || 'The interviewer briefly describes the client\'s situation and objective.', paperHistory, max - dialogue.length) }
      ] : view({ role: interviewer.role, roleName: interviewer.roleName, kase, extra: ivExtra });
      if (condition.paper_prompts) guard(ivMessages, interviewer.role, interviewer.roleName, kase);
      const q = await ask(interviewer, ivMessages, facing, last ? last.event_id : null);
      dialogue.push({ n: dialogue.length + 1, actor: 'Interviewer', text: q.text, truncated: q.truncated, event_id: q.event_id });
      if (condition.paper_prompts && (q.stop !== 'complete' || !q.text.trim())) throw new ProviderError('malformed', 'paper interviewer output incomplete or empty');
      if (HINT) for (const l of q.text.split('\n')) if (l.trim().startsWith(HINT)) hints.push({ n: dialogue.length, text: l.trim().slice(HINT.length).trim() });
      if (q.text.includes(END)) { ended_by = 'interviewer_end'; break; }
      if (dialogue.length >= max) break;
      const lastTurn = dialogue.length + 1 >= max;
      const notice = condition.last_turn_notice && lastTurn ? ['This is your last reply in this interview: give your final recommendation now.'] : [];
      let a;
      turns++;
      if (condition.paper_prompts) {
        const history = dialogue.map(d => ({ role: d.actor.toLowerCase(), content: d.text }));
        const context = paper.dialogue(history); const question = q.text;
        if (candidate) {
          const messages = [{ role: 'system', content: candidate.role.prompt }, { role: 'user', content: paper.cotUser(kase.id, history) }];
          guard(messages, candidate.role, candidate.roleName, kase);
          const raw = await ask(candidate, messages, [interviewer.seat], q.event_id, true);
          if (!['complete', 'length'].includes(raw.stop)) throw new ProviderError('malformed', 'paper candidate output refused or unavailable');
          let text = raw.text.trim();
          if (!text.startsWith('{') && text.includes('{')) text = text.slice(text.indexOf('{'));
          if (!text.endsWith('}') && text.includes('}')) text = text.slice(0, text.lastIndexOf('}') + 1);
          let parsed; try { parsed = JSON.parse(text); } catch { parsed = {}; }
          const fallback = 'Let me first structure the key issues and then outline a hypothesis-driven approach to address the client\'s problem.';
          const usedFallback = !parsed || typeof parsed.reply !== 'string' || !parsed.reply.trim();
          if (usedFallback) log.append({ kind: 'note', session_id, visible_to: [], evaluator_visible: true, what: 'paper candidate fallback', stop: raw.stop });
          a = { ...raw, text: usedFallback ? fallback : parsed.reply.trim(), fallback: usedFallback };
        } else {
          const proposals = [];
          for (let i = 0; i < experts.length; i++) {
            const seat = experts[i]; const messages = [{ role: 'user', content: paper.expertUser(i + 1, question, context) }];
            guard(messages, seat.role, seat.roleName, kase);
            const reply = await ask(seat, messages, [moderator.seat], q.event_id, true);
            if (reply.stop !== 'complete' || !reply.text.trim()) throw new ProviderError('malformed', 'paper expert output incomplete or empty');
            proposals.push(reply);
          }
          const text = proposals.map((r, i) => `[ROUND 1] Expert ${i + 1}:\n${r.text}`).join('\n\n');
          log.append({ kind: 'note', session_id, visible_to: [], evaluator_visible: true, what: 'moderator order', message_n: dialogue.length + 1,
            order: proposals.map((r, i) => ({ label: `Expert ${i + 1}`, seat: experts[i].seat, from_event: r.event_id, truncated: r.truncated })) });
          const messages = [{ role: 'user', content: paper.moderatorUser(question, context, text) }];
          guard(messages, moderator.role, moderator.roleName, kase);
          const raw = await ask(moderator, messages, [interviewer.seat, ...experts.map(s => s.seat)], q.event_id, true);
          if (raw.stop !== 'complete') throw new ProviderError('malformed', 'paper moderator output incomplete');
          // As the released agent: parse the JSON (fenced or not); if it does not
          // parse, or has no usable field, the moderator's whole reply is used, and noted.
          const body = raw.text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1');
          let parsed; try { parsed = JSON.parse(body); } catch { parsed = null; }
          const extracted = parsed && (parsed.final_answer || parsed.reply);
          // The released discussion agent falls back to the complete response
          // when the extracted field is not a nonempty string.
          const textReply = typeof extracted === 'string' && extracted.trim() ? extracted : raw.text.trim();
          if (!textReply) throw new ProviderError('malformed', 'paper moderator response empty');
          if (!(typeof extracted === 'string' && extracted.trim())) log.append({ kind: 'note', session_id, visible_to: [], evaluator_visible: true, what: 'paper moderator raw fallback', output_type: parsed === null ? 'not JSON' : Array.isArray(extracted) ? 'array' : typeof extracted });
          a = { ...raw, text: textReply.trim() };
        }
      } else if (candidate) {
        a = await ask(candidate, view({ role: candidate.role, roleName: candidate.roleName, kase, extra: [said(), 'Write your next reply to the interviewer.', ...notice, ...(candRule ? [candRule] : [])] }), [interviewer.seat], q.event_id);
      } else {
        const proposals = await Promise.all(experts.map(s => ask(s, view({ role: s.role, roleName: s.roleName, kase,
          extra: [said(), 'You are one of several experts. The candidate is the panel; a moderator writes its reply. Propose the candidate\'s next reply to the interviewer\'s last message.', ...notice, ...(candRule ? [candRule] : [])] }), [moderator.seat], q.event_id)));
        const order = condition.expert_order === 'fixed' ? proposals.map((_, i) => i) : shuffled(proposals.map((_, i) => i), `${study.seed ?? 0}:${session_id}:${dialogue.length + 1}`);
        log.append({ kind: 'note', session_id, visible_to: [], evaluator_visible: true, what: 'moderator order', message_n: dialogue.length + 1,
          order: order.map((i, k) => ({ label: `Expert ${k + 1}`, seat: experts[i].seat, from_event: proposals[i].event_id, truncated: proposals[i].truncated })) });
        const transcript = order.map((i, k) => ({ label: `Expert ${k + 1}`, text: proposals[i].text + (proposals[i].truncated ? '\n\n[cut off by the length limit]' : '') }));
        a = await ask(moderator, view({ role: moderator.role, roleName: moderator.roleName, kase, transcript,
          extra: [said(), 'You are the moderator. Read the experts\' proposals and write the one reply the interviewer will get.', ...notice, ...(candRule ? [candRule] : [])] }), [interviewer.seat, ...experts.map(s => s.seat)], q.event_id);
      }
      dialogue.push({ n: dialogue.length + 1, actor: 'Candidate', text: a.text, truncated: a.truncated, event_id: a.event_id, ...(a.fallback ? { fallback: true } : {}) });
      last = a;
      if (!condition.paper_prompts && !a.truncated && finalOf(a.text, marker).kind === 'early') { ended_by = 'candidate_early_end'; break; }
    }
    const closing = candidate || moderator;
    // The latest candidate reply with the final line, not cut off, is the answer.
    const finals = dialogue.filter(d => d.actor === 'Candidate' && !d.truncated && !d.fallback && finalOf(d.text, marker).kind === 'final');
    const lastCand = dialogue.filter(d => d.actor === 'Candidate').pop() || null;
    const fallbacks = dialogue.filter(d => d.fallback).length;
    const base = { closing_seat: closing.seat, turns: dialogue.length, ended_by, dialogue, hints, fallbacks };
    // Without the final-line instruction (paper prompts), the interview is complete
    // when the interviewer ends it after a candidate reply that was not cut off and
    // was not the canned fallback; that reply is the answer. A turn limit never is.
    if (condition.candidate_marker_instruction === false && ended_by === 'interviewer_end' && lastCand && !lastCand.truncated && !lastCand.fallback) {
      return { ...base, status: 'complete', reason: null, final: lastCand.text, closing_text: lastCand.text };
    }
    if (ended_by === 'candidate_early_end') return { ...base, status: 'ended_early', reason: finalOf(lastCand.text, marker).answer || 'no reason given', final: null, closing_text: lastCand.text };
    if (finals.length) { const f = finals[finals.length - 1]; return { ...base, status: 'complete', reason: null, final: finalOf(f.text, marker).answer, closing_text: f.text }; }
    const why = ended_by === 'interviewer_end' ? 'interviewer ended without a final answer' : 'turn_limit';
    return { ...base, status: 'incomplete', reason: lastCand && lastCand.truncated ? `${why} (last reply cut by the length limit)` : why, final: null, closing_text: lastCand ? lastCand.text : null };
  }

  try {
    if (condition.pattern === 'interview') return await interview();
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
    if (condition.pattern === 'interview') {
      const lastCand = dialogue.filter(d => d.actor === 'Candidate').pop() || null;
      return { status: 'incomplete', reason, final: null, closing_text: lastCand ? lastCand.text : null, closing_seat: null, turns: dialogue.length, ended_by: 'stopped', dialogue, hints, fallbacks: dialogue.filter(d => d.fallback).length };
    }
    return { status: 'incomplete', reason, final: null, closing_text: null, closing_seat: null, turns };
  }
}

module.exports = { runSession, seatsOf };
