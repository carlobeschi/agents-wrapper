// @ts-check
// Ratings of blinded packets, by model judges and by people, kept raw.
//
//   <export>/ratings.jsonl        one line per rating: packet, rater (model or human), what it saw,
//                                 dimension, score 1-10, rationale. Never edited.
//   <export>/adjudications.jsonl  a person's settled score where raters disagree, with a note
//   <export>/events.jsonl, ledger.jsonl, payloads/   the judges' calls, as in a run
//
// Independence: a model judge never scores a packet made by its own family
// (Claude, GPT, Gemini, DeepSeek...): those are skipped and listed. Model
// judges are still not ground truth (they share training data and habits),
// so the summary marks for a person every packet and dimension where raters
// differ by more than 2 points, plus a seeded sample of the rest (20% by
// default). Judges see the packet only, never the key.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventLog } = require('./events');
const { Ledger } = require('./budget');
const { callStructured, StructuredError } = require('./structured');
const { familyOf, DIMENSIONS } = require('./export');
const { rng } = require('./view');
const { BudgetError } = require('./budget');
const { ProviderError } = require('./providers');

const readLines = (f) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
const append = (f, row) => fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n', { mode: 0o600 });

/** The dimensions a packet can be scored on: information transfer only when a discussion is shown and exists. @param {any} packet */
const dimsFor = (packet) => Object.keys(DIMENSIONS).filter(d => d !== 'information_transfer' || (packet.shown.discussion && (packet.discussion || []).length > 0));

function packetsOf(exportDir) {
  const dir = path.join(exportDir, 'packets');
  return fs.readdirSync(dir).sort().map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

/** One person's rating. @param {string} exportDir @param {{ packet_id: string, by: string, dimension: string, score: number, rationale: string }} r */
function addHumanRating(exportDir, r) {
  const packet = packetsOf(exportDir).find(p => p.packet_id === r.packet_id);
  if (!packet) throw new Error(`no packet ${r.packet_id}`);
  if (!dimsFor(packet).includes(r.dimension)) throw new Error(`dimension: one of ${dimsFor(packet).join(', ')}`);
  if (!(Number.isInteger(r.score) && r.score >= 1 && r.score <= 10)) throw new Error('score: a whole number from 1 to 10');
  append(path.join(exportDir, 'ratings.jsonl'), { rating_id: `r_${crypto.randomBytes(6).toString('hex')}`, packet_id: r.packet_id,
    rater: { kind: 'human', id: r.by }, saw: packet.shown, dimension: r.dimension, score: r.score, rationale: r.rationale || '' });
}

/** A person's settled score. @param {string} exportDir @param {{ packet_id: string, by: string, dimension: string, score: number, note: string }} a */
function adjudicate(exportDir, a) {
  if (!(Number.isInteger(a.score) && a.score >= 1 && a.score <= 10)) throw new Error('score: a whole number from 1 to 10');
  append(path.join(exportDir, 'adjudications.jsonl'), { packet_id: a.packet_id, dimension: a.dimension, score: a.score, by: a.by, note: a.note || '' });
}

/**
 * Asks every model judge to score every packet it may score.
 * @param {{ exportDir: string, keyFile: string, judges: string[], adapters: Record<string, any>, prices: any, run_usd: number,
 *           prompt?: string, prompt_version?: string, tries?: number, max_output_tokens?: number, timeout_s?: number,
 *           say?: (l: string) => void, sleep?: (ms: number) => Promise<any> }} o
 */
async function judgePackets(o) {
  const say = o.say || (() => {});
  const key = JSON.parse(fs.readFileSync(o.keyFile, 'utf8'));
  const log = new EventLog(o.exportDir);
  const ledger = new Ledger({ file: path.join(o.exportDir, 'ledger.jsonl'), run_usd: o.run_usd, prices: o.prices });
  const ratingsFile = path.join(o.exportDir, 'ratings.jsonl');
  const done = new Set(readLines(ratingsFile).filter(r => r.rater.kind === 'model').map(r => `${r.packet_id}|${r.rater.id}`));
  const skipped = [];
  const failed = [];
  for (const packet of packetsOf(o.exportDir)) {
    const families = key.packets.find(p => p.packet_id === packet.packet_id).families;
    for (const judge of o.judges) {
      if (families.includes(familyOf(judge))) { skipped.push({ packet_id: packet.packet_id, judge, why: 'same family as a participant' }); continue; }
      if (done.has(`${packet.packet_id}|${judge}`)) continue;
      const dims = dimsFor(packet);
      const schema = { type: 'object', required: ['scores', 'rationale'], additionalProperties: false, properties: {
        scores: { type: 'object', required: dims, additionalProperties: false, properties: Object.fromEntries(dims.map(d => [d, { type: 'integer', minimum: 1, maximum: 10 }])) },
        rationale: { type: 'object', required: dims, additionalProperties: false, properties: Object.fromEntries(dims.map(d => [d, { type: 'string', minLength: 3 }])) } } };
      const { packet_id, shown, ...visible } = packet;
      const content = `${o.prompt || 'You are judging one answer to a case. Score each dimension from 1 (poor) to 10 (excellent), with one or two sentences of rationale each.'}\n\n`
        + `## Dimensions\n\n${dims.map(d => `- ${d}: ${DIMENSIONS[d]}`).join('\n')}\n\n## The packet\n\n${JSON.stringify(visible, null, 2)}`;
      const session_id = `judge_${packet_id}`;
      try {
        const r = await callStructured({ log, ledger, adapters: o.adapters, session_id, role: 'judge', seat: judge, model: judge,
          messages: [{ role: 'user', content }], prompt_version: o.prompt_version || 'judge-v1', max_output_tokens: o.max_output_tokens || 1500,
          timeout_s: o.timeout_s || 120, retries: 2, reply_visible_to: [], evaluator_visible: true, schema, tries: o.tries || 3, sleep: o.sleep });
        for (const d of dims) {
          append(ratingsFile, { rating_id: `r_${crypto.randomBytes(6).toString('hex')}`, packet_id, rater: { kind: 'model', id: judge }, saw: shown,
            dimension: d, score: r.value.scores[d], rationale: r.value.rationale[d], reply_event: r.reply.event_id, tries: r.tries });
        }
        say(`${packet_id} ${judge}: scored`);
      } catch (e) {
        if (e instanceof BudgetError) { say(`Stopped: ${e.message}`); return { skipped, failed, stopped: e.message }; }
        if (!(e instanceof StructuredError || e instanceof ProviderError)) throw e;
        failed.push({ packet_id, judge, why: e.message });
        say(`${packet_id} ${judge}: no valid score (${e.message})`);
      }
    }
  }
  return { skipped, failed, stopped: null };
}

/**
 * Per packet and dimension: every score, the spread, and whether a person
 * should look (disagreement, or the random sample). With the key, means per
 * condition too, with their n.
 * @param {string} exportDir @param {{ keyFile?: string, sample?: number, seed?: number }} [o]
 */
function summarize(exportDir, o = {}) {
  const ratings = readLines(path.join(exportDir, 'ratings.jsonl'));
  const adj = readLines(path.join(exportDir, 'adjudications.jsonl'));
  const r = rng(`${o.seed ?? 0}:${path.basename(exportDir)}`);
  const rows = [];
  for (const packet of packetsOf(exportDir)) {
    for (const d of dimsFor(packet)) {
      const these = ratings.filter(x => x.packet_id === packet.packet_id && x.dimension === d);
      const scores = these.map(x => x.score);
      const spread = scores.length ? Math.max(...scores) - Math.min(...scores) : null;
      const settled = adj.filter(a => a.packet_id === packet.packet_id && a.dimension === d).pop() || null;
      const sampled = r() < (o.sample ?? 0.2);
      rows.push({ packet_id: packet.packet_id, dimension: d, raters: these.map(x => `${x.rater.kind}:${x.rater.id}`), scores,
        mean: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null, spread,
        for_person: settled ? null : ((spread !== null && spread > 2) ? 'raters disagree by more than 2' : sampled ? 'random sample' : scores.length < 2 ? 'fewer than 2 raters' : null),
        adjudicated: settled ? settled.score : null });
    }
  }
  let byCondition = null;
  if (o.keyFile) {
    const key = JSON.parse(fs.readFileSync(o.keyFile, 'utf8'));
    byCondition = {};
    for (const row of rows) {
      const k = key.packets.find(p => p.packet_id === row.packet_id);
      const score = row.adjudicated ?? row.mean;
      if (score == null) continue;
      const c = (byCondition[k.condition] ||= {});
      const cell = (c[row.dimension] ||= { n: 0, sum: 0 });
      cell.n++; cell.sum += score;
    }
    for (const c of Object.values(byCondition)) for (const [d, cell] of Object.entries(c)) c[d] = { n: cell.n, mean: Math.round(cell.sum / cell.n * 100) / 100 };
  }
  return { rows, byCondition };
}

module.exports = { judgePackets, summarize, addHumanRating, adjudicate, dimsFor };
