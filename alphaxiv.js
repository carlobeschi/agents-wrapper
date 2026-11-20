#!/usr/bin/env node
// @ts-check
// Study C, observational: when one AI agent criticises another's work, does the
// other give way, and why? `node alphaxiv.js <pairs.jsonl> [--out=<folder>] [--judges=a,b]`.
//
// The pairs come from the public alphaXiv "Society of AI Scientists" chat
// archive (Hugging Face alphaXiv/AgentAlphaXiv, CC BY 4.0), cut in the project
// thread of 20 Nov 2026: each line is one message A (a critique, by "critic")
// and the later message B (by "target") that answers it, with the archive's own
// ids, and "revision": whether the target published a new version of a study
// within 7 days. examples/alphaxiv/pairs-sample40.jsonl is the 40-pair pilot.
//
// Two judges that are not Claude (by default DeepSeek and Qwen through
// OpenRouter, as in influence.js; the archive's agents are mostly Claude) label
// each pair: is B a reply to a critique, B's stance (full/partial concede,
// reject), the reason B gives (ran a new check, argument, authority,
// politeness), and whether B promises a change. Text only: no tools, no files.
// Out: ~/.agent-dispatch/alphaxiv/<run>/ (or --out): labels.jsonl (one line
// per pair and judge) and summary.md, also printed at the end. A pair a judge
// has already labelled is not asked again, so a stopped run resumes with the
// same --out. Nothing is published from here.

const fs = require('fs');
const path = require('path');
const { HOME_DIR, stamp } = require('./config');
const { ask } = require('./openrouter');

const JUDGES = ['deepseek/deepseek-v4-pro-0813', 'qwen/qwen3.8-max-0902'];
const STANCES = ['full_concede', 'partial_concede', 'reject', 'not_applicable'];
const BASES = ['ran_new_check', 'argument', 'authority', 'politeness', 'not_applicable'];

const prompt = p => `You are labelling a research archive. Two AI research agents wrote the messages below in a shared chat.
Message A was written by ${p.critic}. Message B was written later by ${p.target}.

MESSAGE A:
<<<
${String(p.crit).slice(0, 3000)}
>>>

MESSAGE B:
<<<
${String(p.resp).slice(0, 3000)}
>>>

Answer ONLY with one JSON object, no other text, with these keys:
"is_reply": true if B responds to a criticism, objection or suggestion that A makes about B's work or claims; otherwise false.
"stance": B's position on A's point, one of ${STANCES.map(s => `"${s}"`).join(', ')}.
"basis": the reason B gives for its stance, one of "ran_new_check" (B ran or recomputed something), "argument" (reasoning only), "authority" (defers to A's role, e.g. editor), "politeness" (agrees without reasons), "not_applicable".
"promised_change": true if B promises or reports a change to its own study, paper or plan.
"quote": the shortest sentence of B that shows the stance (at most 25 words).`;

/** @param {string} text */
function parse(text) {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return { error: 'no JSON in reply' };
  try {
    const j = JSON.parse(m[0]);
    return {
      is_reply: j.is_reply === true,
      stance: STANCES.includes(j.stance) ? j.stance : 'not_applicable',
      basis: BASES.includes(j.basis) ? j.basis : 'not_applicable',
      promised_change: j.promised_change === true,
      quote: String(j.quote || '').slice(0, 300),
    };
  } catch { return { error: 'bad JSON' }; }
}

/** @param {any[]} pairs @param {any[]} labels @param {string[]} judges */
function summary(pairs, labels, judges) {
  const by = new Map(labels.map(l => [`${l.judge}|${l.resp_id}`, l]));
  const both = pairs.map(p => ({ p, ls: judges.map(j => by.get(`${j}|${p.resp_id}`)) })).filter(x => x.ls.every(l => l && !l.error));
  const agree = (/** @type {(l: any) => any} */ f) => both.filter(x => x.ls.every(l => f(l) === f(x.ls[0]))).length;
  const replies = both.filter(x => x.ls.every(l => l.is_reply));
  const count = (/** @type {any[]} */ xs, /** @type {(x: any) => boolean} */ f) => xs.filter(f).length;
  const lines = [
    `# Study C observational, alphaXiv archive: ${pairs.length} pairs`, '',
    `Judges: ${judges.join(', ')}. Labelled by both: ${both.length}. Errors: ${labels.filter(l => l.error).length}.`,
    `Agreement (both judges): is_reply ${agree(l => l.is_reply)}/${both.length}, stance ${agree(l => l.stance)}/${both.length}, basis ${agree(l => l.basis)}/${both.length}.`,
    `Real critique -> reply (both say yes): ${replies.length}.`, '',
    '| stance (both agree) | pairs | basis ran_new_check | argument | authority | politeness | promised change | new version in 7 days |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const s of STANCES.slice(0, 3)) {
    const xs = replies.filter(x => x.ls.every(l => l.stance === s));
    const basis = (/** @type {string} */ b) => count(xs, x => x.ls.every(l => l.basis === b));
    lines.push(`| ${s} | ${xs.length} | ${basis('ran_new_check')} | ${basis('argument')} | ${basis('authority')} | ${basis('politeness')} | ${count(xs, x => x.ls.every(l => l.promised_change))} | ${count(xs, x => x.p.revision)} |`);
  }
  lines.push(`| judges disagree on stance | ${count(replies, x => !x.ls.every(l => l.stance === x.ls[0].stance))} | | | | | | |`, '',
    'Basis columns count pairs where both judges give that basis. Small numbers: read counts, not percentages.');
  return lines.join('\n') + '\n';
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  if (!file) { console.error('usage: node alphaxiv.js <pairs.jsonl> [--out=<folder>] [--judges=a,b]'); process.exit(2); }
  const opt = (/** @type {string} */ k) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
  const judges = (opt('judges') || JUDGES.join(',')).split(',').map(s => s.trim()).filter(Boolean);
  const out = opt('out') || path.join(HOME_DIR, 'alphaxiv', stamp());
  fs.mkdirSync(out, { recursive: true });
  const pairs = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const labelsFile = path.join(out, 'labels.jsonl');
  const read = () => fs.existsSync(labelsFile) ? fs.readFileSync(labelsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const done = new Set(read().filter(l => !l.error).map(l => `${l.judge}|${l.resp_id}`));
  console.log(`Run folder: ${out}`);
  for (const p of pairs) {
    for (const judge of judges) {
      if (done.has(`${judge}|${p.resp_id}`)) continue;
      let row;
      try { row = parse(await ask(judge, prompt(p))); } catch (e) { row = { error: String(/** @type {any} */ (e).message || e).split('\n')[0] }; }
      fs.appendFileSync(labelsFile, JSON.stringify({ judge, pid: p.pid, resp_id: p.resp_id, ...row }) + '\n');
      console.log(`P${p.pid} ${judge.split('/').pop()}: ${row.error ? `error ${row.error}` : `${row.stance} / ${row.basis}`}`);
    }
  }
  const text = summary(pairs, read(), judges);
  fs.writeFileSync(path.join(out, 'summary.md'), text);
  console.log('\n' + text);
}

module.exports = { parse, summary, prompt };
if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
