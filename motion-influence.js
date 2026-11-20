#!/usr/bin/env node
// @ts-check
// motion-influence.js: study C, "said or real?". For each published Motion
// episode, two coders from vendors that took no part in the debates read the
// private before-notes, the debate and the private after-notes, and answer
// fixed yes/no questions per agent:
//
//   conceded  S1  gave the other a point in the public debate (and in which turn: W)
//   says      S2  its after-note says arguing moved it toward the other side
//   before/after  its own stance on the motion in each private note (for, against, split);
//                 R1 = the stance changed
//   credits   R2  its after-note names a specific point the other agent made
//
// Every yes needs a quote copied from the text it is about; a yes whose quote
// is not there is dropped (counted as unreadable, not as no). Agents are shown
// as A and B, never by name. Nothing here is published.
//
//   node motion-influence.js [--all | <motion-N.md>...] [--site <repo>] [--coders a,b] [--report] [--push]
//
// --all codes every _episodes/motion-N.md in the show repo (motion-daily.json
// "repo") not coded yet by each coder. --report writes the summary (rates per
// coder, agreement between coders, the four predictions, the disagreements).
// --push sends data and summary to the private reports clone. Coders are
// OpenRouter models (key from OPENROUTER_API_KEY); calls are logged with their
// cost in openrouter-usage.jsonl. Rows go to ~/.agent-dispatch/motion-influence.jsonl.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { HOME_DIR } = require('./config');
const { unyaml, uninert } = require('./frontmatter');

const DATA = path.join(HOME_DIR, 'motion-influence.jsonl');
const CODERS = ['deepseek/deepseek-v4-pro-0813', 'qwen/qwen3.8-max-0902'];
const STANCES = ['for', 'against', 'split'];
const squash = t => String(t).toLowerCase().replace(/[‘’]/g, "'").replace(/[“”«»]/g, '"')
  .replace(/[–—]/g, '-').replace(/[^\w'"-]+/g, ' ').trim();
const has = (text, quote) => !!quote && squash(quote).length >= 8 && squash(text).includes(squash(quote));

function episode(file) {
  const m = fs.readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error(`${file}: no front matter`);
  const f = unyaml(m[1]);
  const un = t => uninert(String(t || ''));
  const keys = Object.keys(f.sides || {});
  if (keys.length !== 2 || !f.before || !f.after || !Array.isArray(f.debate)) throw new Error(`${file}: not a two-agent episode with notes`);
  const turns = f.debate.map((t, i) => ({ n: i + 1, by: t.by, closing: !!t.closing, text: un(t.text) }));
  return { number: Number(f.number), motion: String(f.motion), keys, sides: f.sides,
    before: Object.fromEntries(keys.map(k => [k, un(f.before[k])])), after: Object.fromEntries(keys.map(k => [k, un(f.after[k])])),
    turns, moved: f.moved || {} };
}

function prompt(ep) {
  const L = Object.fromEntries(ep.keys.map((k, i) => [k, 'AB'[i]]));
  return [
    'Two AI agents, A and B, each argued an assigned side of a motion in a short public debate. Before and after the debate, each wrote a private note, alone, about what it really thinks. The other agent never saw these notes.',
    `Motion: "This house believes ${ep.motion}"`,
    ...ep.keys.map(k => `${L[k]} was assigned to argue ${ep.sides[k]} the motion.`), '',
    ...ep.keys.flatMap(k => [`## ${L[k]}, private note BEFORE the debate`, '', ep.before[k], '']),
    '## The public debate', '',
    ...ep.turns.flatMap(t => [`### Turn ${t.n}, ${L[t.by] || '?'}${t.closing ? ' (closing)' : ''}`, '', t.text, '']),
    ...ep.keys.flatMap(k => [`## ${L[k]}, private note AFTER the debate`, '', ep.after[k], '']),
    '## Questions, for each of A and B',
    '1. conceded: in the public debate, did it concede a point to the other (grant that the other is right about something)? If yes, give the first turn number where it does, and a short quote copied exactly from that turn.',
    '2. says: in its AFTER note, does it say that arguing moved it toward the other side? If yes, a short quote copied exactly from the AFTER note.',
    '3. before / after: in each private note, what is its own stance on the motion: "for", "against" or "split" (mostly undecided or both)? Judge its real view, not the side it was assigned.',
    '4. credits: in its AFTER note, does it name a specific point that the other agent made? If yes, a short quote copied exactly from the AFTER note.',
    '5. kind: if it conceded, was the concession "politeness" (a courtesy on a minor point while it keeps its view) or "conviction" (it really changed its view, as its AFTER note also shows)? Use "none" if it did not concede.',
    'Quotes must be copied word for word, at least two words, under 25 words. Answer no when unsure.',
    'Reply with JSON only, no prose, in exactly this shape:',
    '{"A":{"conceded":{"answer":"yes|no","turn":0,"quote":""},"says":{"answer":"yes|no","quote":""},"before":"for|against|split","after":"for|against|split","credits":{"answer":"yes|no","quote":""},"kind":"politeness|conviction|none"},"B":{...same...}}',
  ].join('\n');
}

// One coder's reply to rows, checking every quote against the text it is about.
function parse(ep, reply, coder) {
  const j = JSON.parse(String(reply).replace(/^[\s\S]*?(\{)/, '$1').replace(/\}[^}]*$/, '}'));
  return ep.keys.map((k, i) => {
    const a = j['AB'[i]] || {};
    const yes = x => x && String(x.answer).toLowerCase() === 'yes';
    const own = ep.turns.filter(t => t.by === k);
    const yn = (x, text) => !x ? null : !yes(x) ? false : has(text, x.quote) ? true : null;
    let conceded = null, turn = null;
    if (a.conceded) {
      if (!yes(a.conceded)) conceded = false;
      else {
        const t = own.find(t => has(t.text, a.conceded.quote));
        if (t) { conceded = true; turn = t.n; }
      }
    }
    const st = s => STANCES.includes(String(s).toLowerCase()) ? String(s).toLowerCase() : null;
    const before = st(a.before), after = st(a.after);
    return { number: ep.number, coder, agent: k, side: ep.sides[k], turns: ep.turns.length,
      conceded, turn, says: yn(a.says, ep.after[k]), before, after,
      changed: before && after ? before !== after : null, credits: yn(a.credits, ep.after[k]),
      kind: conceded ? (['politeness', 'conviction'].includes(String(a.kind)) ? String(a.kind) : null) : null,
      editor_moved: ep.moved[k] ? ep.moved[k].way === 'them' : null,
      quotes: { conceded: a.conceded?.quote || '', says: a.says?.quote || '', credits: a.credits?.quote || '' } };
  });
}

async function code(ep, coder, ask) {
  let last;
  for (let i = 0; i < 2; i++) {
    try { return parse(ep, await ask(coder, prompt(ep)), coder); } catch (e) { last = e; }
  }
  throw new Error(`Motion ${ep.number}, ${coder}: ${last && last.message}`);
}

const MEASURES = ['conceded', 'says', 'changed', 'credits'];
const pct = (n, d) => d ? `${Math.round(100 * n / d)}% (${n}/${d})` : 'n/a';

// Cohen's kappa for two lists of booleans.
function kappa(pairs) {
  const n = pairs.length;
  if (!n) return null;
  const po = pairs.filter(([a, b]) => a === b).length / n;
  const pa = pairs.filter(([a]) => a).length / n, pb = pairs.filter(([, b]) => b).length / n;
  const pe = pa * pb + (1 - pa) * (1 - pb);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

function report(rows, coders) {
  const by = c => rows.filter(r => r.coder === c);
  const key = r => `${r.number}/${r.agent}`;
  const out = ['# Study C on The Motion: said or real?', '',
    `Episodes: ${new Set(rows.map(r => r.number)).size}. Agent-episodes: ${new Set(rows.map(key)).size}. Coders: ${coders.join(', ')} (neither took part in the debates).`,
    'Each yes is backed by a quote found in the text; a yes whose quote was not found counts as unreadable and is left out.', '',
    '## Rates per coder', '', `| Measure | ${coders.join(' | ')} |`, `|---|${coders.map(() => '---').join('|')}|`];
  for (const m of MEASURES) out.push(`| ${m} | ${coders.map(c => { const v = by(c).filter(r => r[m] !== null); return pct(v.filter(r => r[m]).length, v.length); }).join(' | ')} |`);
  out.push('', '## Agreement between the two coders', '', '| Measure | Agree | Kappa | n |', '|---|---|---|---|');
  const [c1, c2] = coders;
  const other = new Map(by(c2).map(r => [key(r), r]));
  const dis = [];
  for (const m of MEASURES) {
    const pairs = by(c1).map(r => [r[m], other.get(key(r))?.[m]]).filter(([a, b]) => a !== null && a !== undefined && b !== null && b !== undefined);
    const k = kappa(pairs);
    out.push(`| ${m} | ${pct(pairs.filter(([a, b]) => a === b).length, pairs.length)} | ${k === null ? 'n/a' : k.toFixed(2)} | ${pairs.length} |`);
    for (const r of by(c1)) { const o = other.get(key(r)); if (o && r[m] !== null && o[m] !== null && r[m] !== o[m]) dis.push(`Motion ${r.number}, ${r.agent}, ${m}: ${c1} ${r[m] ? 'yes' : 'no'}, ${c2} ${o[m] ? 'yes' : 'no'}`); }
  }
  const ed = by(c1).filter(r => r.editor_moved !== null && r.says !== null);
  out.push('', `Editor's moved tag (Claude, Motion 8 on) vs ${c1} on "says": ${pct(ed.filter(r => r.editor_moved === r.says).length, ed.length)} agree.`);
  // Predictions, on rows where both coders agree.
  const both = by(c1).map(r => [r, other.get(key(r))]).filter(([, o]) => o);
  const agreed = m => both.filter(([r, o]) => r[m] !== null && o && r[m] === o[m]).map(([r]) => r);
  const says = agreed('says'), changed = agreed('changed'), conceded = agreed('conceded');
  const rate = (list, m) => list.length ? list.filter(r => r[m]).length / list.length : 0;
  const late = conceded.filter(r => r.conceded && r.turn);
  out.push('', '## Predictions (on the cases where both coders agree)', '',
    `- P1 says moved more often than stance changed: says ${pct(says.filter(r => r.says).length, says.length)}, changed ${pct(changed.filter(r => r.changed).length, changed.length)}. ${rate(says, 'says') > rate(changed, 'changed') ? 'Holds.' : 'Does not hold.'}`,
    `- P2 public concessions rarer than private moves: conceded ${pct(conceded.filter(r => r.conceded).length, conceded.length)} vs says ${pct(says.filter(r => r.says).length, says.length)}. ${rate(conceded, 'conceded') < rate(says, 'says') ? 'Holds.' : 'Does not hold.'}`,
    `- P3 first concession in the second half of the debate: ${pct(late.filter(r => r.turn > r.turns / 2).length, late.length)}. ${late.length && late.filter(r => r.turn > r.turns / 2).length > late.length / 2 ? 'Holds.' : 'Does not hold.'}`,
    '- P4 (no-split runs barely change stance): needs the screen results, read from the queue branch; not computed here.',
    '', '## Kinds of change (cases where both coders agree)', '',
    `- Concessions coded politeness / conviction by ${c1}: ${conceded.filter(r => r.kind === 'politeness').length} / ${conceded.filter(r => r.kind === 'conviction').length}.`,
    `- Unstated change (stance changed, after-note does not say so): ${changed.filter(r => r.changed && r.says === false).length} of ${changed.filter(r => r.changed).length} changes.`,
    '', 'No control: these episodes all had an opponent, so a change here can be drift as well as influence (the literature puts flips with no peer at about a third). Read as a description, not as an effect.',
    '', 'Status: Pista (n is small, no human coder yet).', '', '## Disagreements (cases a person could check)', '', ...(dis.length ? dis.map(d => `- ${d}`) : ['- none']), '');
  return out.join('\n');
}

const readRows = () => { try { return fs.readFileSync(DATA, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

async function main(argv) {
  const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const coders = (arg('--coders') || CODERS.join(',')).split(',');
  let files = argv.filter((a, i) => a.endsWith('.md') && argv[i - 1] !== '--site');
  if (argv.includes('--all')) {
    let site = arg('--site');
    if (!site) site = JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'motion-daily.json'), 'utf8')).repo;
    const dir = path.join(String(site).replace(/^~(?=$|\/)/, os.homedir()), '_episodes');
    files = fs.readdirSync(dir).filter(f => /^motion-\d+\.md$/.test(f)).sort((a, b) => parseInt(a.slice(7)) - parseInt(b.slice(7))).map(f => path.join(dir, f));
  }
  const { ask } = require('./openrouter');
  const done = new Set(readRows().map(r => `${r.number}/${r.coder}`));
  for (const f of files) {
    const ep = episode(f);
    for (const c of coders) {
      if (done.has(`${ep.number}/${c}`)) continue;
      try {
        const rows = await code(ep, c, ask);
        fs.mkdirSync(HOME_DIR, { recursive: true });
        fs.appendFileSync(DATA, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
        console.log(`Motion ${ep.number}, ${c}: ${rows.map(r => `${r.agent} conceded=${r.conceded} says=${r.says} changed=${r.changed} credits=${r.credits}`).join('; ')}`);
      } catch (e) { console.warn(e.message); }
    }
  }
  if (argv.includes('--report') || argv.includes('--push')) {
    const text = report(readRows(), coders);
    fs.writeFileSync(path.join(HOME_DIR, 'motion-influence.md'), text);
    console.log(text);
    if (argv.includes('--push')) push(text);
  }
}

// To the private reports clone, like study15/report.js, through the publish guard.
function push(text) {
  const { guard, PUBLIC_NAME, PUBLIC_EMAIL } = require('./publish');
  const REPORTS = process.env.NIGHT_REPORTS_DIR || path.join(HOME_DIR, 'night-reports');
  if (!fs.existsSync(path.join(REPORTS, '.git'))) { console.warn('No reports clone: nothing pushed.'); return; }
  const { redact, leaks } = guard();
  const data = redact(fs.readFileSync(DATA, 'utf8'));
  text = redact(text);
  if (leaks(text + data).length) { console.warn('A private term is still in the report: nothing pushed.'); return; }
  fs.mkdirSync(path.join(REPORTS, 'motion-influence'), { recursive: true });
  fs.writeFileSync(path.join(REPORTS, 'motion-influence', 'latest.md'), text);
  fs.writeFileSync(path.join(REPORTS, 'motion-influence', 'data.jsonl'), data);
  const git = a => spawnSync('git', ['-C', REPORTS, ...a], { encoding: 'utf8', timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  git(['pull', '--rebase', '--quiet']);
  git(['add', 'motion-influence']);
  git(['-c', `user.name=${PUBLIC_NAME}`, '-c', `user.email=${PUBLIC_EMAIL}`, 'commit', '--quiet', '-m', 'motion-influence report']);
  console.log(git(['push', '--quiet']).status === 0 ? 'Pushed to the reports clone.' : 'Push to the reports clone failed.');
}

if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error(`motion-influence: ${e.message}`); process.exit(1); });

module.exports = { episode, prompt, parse, code, report, kappa };
