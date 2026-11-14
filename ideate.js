#!/usr/bin/env node
// Ask the agents themselves: `node ideate.js <ideate.json> [--setups a,b] [--agents x,y]`.
//
// A meta-experiment. Every agent (Claude, Gemini, Codex, open models through
// OpenRouter) is asked, alone and with the same prompt, to propose ways for AI
// agents to work together that are NOT copied from how people work together.
// Three setups:
//   plain       - the bare question.
//   affordances - the same question plus a list of what is different about
//                 agents (they can be copied, forked, reset, can read each
//                 other's whole context...), to see whether naming those
//                 properties moves them away from human formats.
//   gaps        - runs after the other two: it sees every idea so far (names
//                 and mechanisms, no authors) and the formats we have already
//                 tried, and must propose only what is missing.
// Then two judges from different vendors label every idea, without knowing who
// wrote it: how close it is to a human format (and which), whether it is the
// same as something we already tried (T*) or already on our own list (M*),
// and whether it can be tested cheaply with text-only agents. A last pass
// groups the ideas into clusters, so we can see which ideas several models
// reach and which only one does.
// Out: ~/.agent-dispatch/ideate/<stamp>/ (ideas.json, labels.json,
// clusters.json, summary.md). Work already done is kept: run it again with
// --out=<folder> and only missing steps run.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HOME_DIR, loadConfig, stamp } = require('./config');

const FIELDS = ['IDEA', 'MECHANISM', 'NOT HUMAN BECAUSE', 'CLOSEST HUMAN ANALOGUE', 'TEST'];

const AFFORDANCES = [
  'Things that are true of AI agents and not of people (use them, don\'t just list them):',
  '- An agent can be copied exactly, many times, at no cost, and every copy starts from the same state.',
  '- An agent can be forked mid-task: N copies continue from the very same context and diverge.',
  '- An agent can be reset to any earlier point and replayed; the same moment can be tried again.',
  '- An agent has no memory between calls unless it is given text; memory is whatever we put in the context.',
  '- One agent can be handed another agent\'s entire working context or private notes, not a summary.',
  '- Agents can be shown or denied any information, with certainty about who saw what.',
  '- An agent cannot reliably tell its own earlier text from another agent\'s if names are removed.',
  '- Agents have no fatigue, ego, career or face to save; their "preferences" come from training and prompt.',
  '- Agents can run thousands of times in parallel, and the harness can make them strictly synchronous.',
  '- Messages can be limited to any size or any alphabet, and agents can be given or denied a shared code.',
  '- Different models (vendors) have different training, so their errors and tastes are partly independent.',
].join('\n');

function askPrompt(c, setup, pool) {
  const head = [
    'We run a small lab that studies what happens when AI agents (language models from different vendors) try to work together on a task: a drawing in SVG, a poem with rules, a puzzle, a small program.',
    'We want ways of working together that are NOT copied from how people work together. Meetings, debate, brainstorming, taking turns, an editor and a writer, a manager and workers, voting: these are human formats and we already know them. Insect and animal collectives are also known to us (ants leaving marks, bees choosing a nest).',
    'Propose exactly 5 ways for 2 to 20 AI agents to work together that would not make sense, or would not be possible, for a group of people. Be concrete: what each agent sees, what it can do, what it sends, how the result is put together.',
    'Be honest about the closest human or animal analogue, even if it is close. An idea that is a human format with new words is less useful to us than a strange idea that might not work.',
    `Each idea must be testable with agents that can only read and write text (no training, no access to model internals), with a budget of about £1.`,
  ];
  const extra = setup === 'affordances' ? ['', AFFORDANCES]
    : setup === 'gaps' ? ['', 'Formats we have already tried:', ...c.tried.map(t => `- ${t.text}`), '',
        'Ideas other agents have already proposed (do NOT repeat any of them or a variant of them; propose only what is missing from this whole list):',
        ...pool.map(p => `- ${p.idea}: ${p.mechanism}`)]
    : [];
  return [...head, ...extra, '',
    'Answer with exactly 5 blocks in this format, and nothing else:', '',
    ...FIELDS.map(f => `${f}: ${f === 'IDEA' ? 'a short name' : f === 'TEST' ? 'one task from our list and what you would measure' : f === 'CLOSEST HUMAN ANALOGUE' ? 'the nearest human or animal practice, or "none"' : '...'}`),
    '', 'Leave one blank line between blocks. Keep each block under 120 words.',
    'You run unattended: any tool that needs permission is refused. Don\'t use tools; just answer.'].join('\n');
}

// The ideas in a reply: blocks that start with "IDEA:".
function parseIdeas(text) {
  const out = [];
  let cur = null;
  const key = l => { const m = l.match(/^\W*(IDEA|MECHANISM|NOT HUMAN BECAUSE|CLOSEST HUMAN ANALOGUE|TEST)[*_\s]*:[*_\s]*(.*)$/i); return m ? [m[1].toUpperCase(), m[2].trim()] : null; };
  for (const l of String(text).split('\n')) {
    const k = key(l);
    if (k && k[0] === 'IDEA') { cur = { idea: k[1].replace(/[*_]+$/g, '').trim() }; out.push(cur); continue; }
    if (!cur) continue;
    const f = k ? k[0].toLowerCase().replace(/ /g, '_').replace('not_human_because', 'not_human').replace('closest_human_analogue', 'analogue') : null;
    if (k) cur[f] = k[1];
    else if (l.trim() && cur._last) cur[cur._last] += ' ' + l.trim();
    if (k) cur._last = f;
  }
  return out.map(({ _last, ...i }) => ({ idea: i.idea, mechanism: i.mechanism || '', not_human: i.not_human || '', analogue: i.analogue || '', test: i.test || '' }))
    .filter(i => i.idea && i.mechanism);
}

// Authors out: model and vendor names become "an agent".
function anonymise(text) {
  return String(text).replace(/\b(Claude|Anthropic|Opus|Sonnet|Haiku|Fable|Codex|OpenAI|GPT[-\w.]*|ChatGPT|Gemini|Google|DeepMind|DeepSeek|Qwen|GLM|Llama|Mistral)\b/gi, 'an agent');
}

function labelPrompt(c, batch) {
  return [
    'Below are proposals for ways AI agents could work together. Each has an id (#n). Authors are hidden.',
    'For each proposal, label it against two reference lists.',
    '', 'T: formats our lab has already tried:', ...c.tried.map(t => `${t.id}: ${t.text}`),
    '', 'M: ideas already on our own list (not tried yet):', ...c.catalogue.map(m => `${m.id}: ${m.text}`),
    '', 'Answer with one line per proposal, in this exact format, and nothing else:',
    '#n | HUMAN: none, partial or close | ANALOGUE: the nearest human or animal practice in under 8 words, or none | SAME AS: T or M ids it is essentially the same as (e.g. T3, M7), or none | CHEAP: yes or no (testable with text-only agents for about £1) | WHY: under 15 words',
    'HUMAN means: is this a format a group of people (or animals) already uses, renamed? "close" = yes, "partial" = shares the core with a human format but changes something real, "none" = no group of people could do it this way.',
    'Judge the mechanism, not the wording. Be strict: renaming a meeting is still a meeting.',
    'You run unattended: any tool that needs permission is refused. Don\'t use tools; just answer.',
    '', '--- Proposals ---', '',
    ...batch.map(i => `#${i.n} ${anonymise(i.idea)}: ${anonymise(i.mechanism)} (Claimed not human because: ${anonymise(i.not_human)})`),
  ].join('\n');
}

function parseLabels(text) {
  const out = {};
  for (const l of String(text).split('\n')) {
    const m = l.match(/^\W*#?(\d+)[*_\s]*\|(.*)$/);
    if (!m) continue;
    const get = k => ((m[2].match(new RegExp(`${k}\\s*:\\s*([^|]*)`, 'i')) || [])[1] || '').trim().replace(/[*_`.]+$/g, '');
    const human = (get('HUMAN').toLowerCase().match(/none|partial|close/) || [null])[0];
    const same = get('SAME AS').toUpperCase().match(/\b[TM]\d+\b/g) || [];
    const cheap = (get('CHEAP').toLowerCase().match(/yes|no/) || [null])[0];
    out[m[1]] = { human, analogue: get('ANALOGUE'), same, cheap, why: get('WHY') };
  }
  return out;
}

function clusterPrompt(ideas) {
  return [
    'Below are proposals (#n) for ways AI agents could work together. Group them by their core mechanism (what actually happens between the agents), not by wording or task.',
    'Answer with one line per group, in this exact format, and nothing else:',
    'CLUSTER: a short name | IDS: #a, #b, ... | CORE: the shared mechanism in under 15 words',
    'Every proposal must be in exactly one group. A proposal that shares its core with no other is a group of one.',
    'You run unattended: any tool that needs permission is refused. Don\'t use tools; just answer.',
    '', '--- Proposals ---', '',
    ...ideas.map(i => `#${i.n} ${anonymise(i.idea)}: ${anonymise(i.mechanism)}`),
  ].join('\n');
}

function parseClusters(text) {
  const out = [];
  for (const l of String(text).split('\n')) {
    const m = l.match(/CLUSTER\s*:\s*([^|]+)\|\s*IDS\s*:\s*([^|]+)(?:\|\s*CORE\s*:\s*(.*))?$/i);
    if (m) out.push({ name: m[1].trim().replace(/[*_]+/g, ''), ids: (m[2].match(/\d+/g) || []).map(Number), core: (m[3] || '').trim() });
  }
  return out;
}

const pct = (a, b) => b ? `${Math.round(100 * a / b)}%` : '-';

function summaryMd(c, ideas, labels, clusters) {
  const judges = Object.keys(labels);
  // An idea's verdict: "none" only if every judge said none; "close" if any said close.
  const verdict = i => {
    const v = judges.map(j => labels[j][i.n]?.human).filter(Boolean);
    return !v.length ? null : v.every(x => x === 'none') ? 'none' : v.includes('close') ? 'close' : 'partial';
  };
  const sameAs = i => [...new Set(judges.flatMap(j => labels[j][i.n]?.same || []))];
  const cheap = i => judges.every(j => labels[j][i.n]?.cheap === 'yes');
  const groups = (key) => [...new Set(ideas.map(i => i[key]))];
  const row = (name, xs) => {
    const v = xs.map(verdict);
    return `| ${name} | ${xs.length} | ${pct(v.filter(x => x === 'none').length, xs.length)} | ${pct(v.filter(x => x === 'close').length, xs.length)} | ${pct(xs.filter(i => sameAs(i).some(s => s.startsWith('T'))).length, xs.length)} | ${pct(xs.filter(i => sameAs(i).some(s => s.startsWith('M'))).length, xs.length)} | ${pct(xs.filter(i => !sameAs(i).length).length, xs.length)} | ${pct(xs.filter(cheap).length, xs.length)} |`;
  };
  const head = '| | ideas | not human (all judges) | human format (any judge) | = tried (T) | = our list (M) | new to us | cheap (all judges) |\n|---|---|---|---|---|---|---|---|';
  const byN = Object.fromEntries(ideas.map(i => [i.n, i]));
  const agreement = (() => {
    if (judges.length < 2) return null;
    const both = ideas.filter(i => judges.every(j => labels[j][i.n]?.human));
    return both.length ? `${both.filter(i => new Set(judges.map(j => labels[j][i.n].human)).size === 1).length} of ${both.length}` : null;
  })();
  const L = [
    `# ${c.title}`, '',
    `Judges: ${judges.join(', ')}. Judge agreement on HUMAN (same label): ${agreement || '-'}. Authors were hidden from judges and clusterer.`, '',
    '## By agent', '', head, ...groups('agent').map(a => row(a, ideas.filter(i => i.agent === a))), '',
    '## By setup', '', head, ...groups('setup').map(s => row(s, ideas.filter(i => i.setup === s))), '',
    '## Clusters (who reaches the same idea)', '',
    '| cluster | ideas | agents | setups | verdict mix | core |', '|---|---|---|---|---|---|',
    ...clusters.map(k => {
      const xs = k.ids.map(n => byN[n]).filter(Boolean);
      const v = xs.map(verdict);
      return `| ${k.name} | ${xs.length} | ${[...new Set(xs.map(i => i.agent))].join(', ')} | ${[...new Set(xs.map(i => i.setup))].join(', ')} | none ${v.filter(x => x === 'none').length}, partial ${v.filter(x => x === 'partial').length}, close ${v.filter(x => x === 'close').length} | ${k.core} |`;
    }), '',
    '## New to us and judged not human by every judge', '',
    ...ideas.filter(i => verdict(i) === 'none' && !sameAs(i).length).map(i => `- **${i.idea}** (${i.agent}, ${i.setup}): ${i.mechanism} Test: ${i.test}${cheap(i) ? '' : ' (not cheap, per a judge)'}`), '',
    '## Self-label vs judges', '',
    `Agent said its idea has no human analogue ("none"): ${ideas.filter(i => /^\W*none\b/i.test(i.analogue)).length} of ${ideas.length}; of those, judged "none" by every judge: ${ideas.filter(i => /^\W*none\b/i.test(i.analogue) && verdict(i) === 'none').length}.`, '',
  ];
  return L.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  if (!file) { console.error('usage: node ideate.js <ideate.json> [--setups plain,affordances,gaps] [--agents a,b] [--out=<folder>]'); process.exit(2); }
  const flag = n => (args.find(a => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : '');
  const c = { title: 'Ask the agents: ways of working together that are not human', repeats: 2, setups: ['plain', 'affordances', 'gaps'], gaps_repeats: 1,
    judges: ['claude', 'codex'], clusterer: 'claude', ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  const setups = flag('setups') ? flag('setups').split(',') : c.setups;
  const ids = flag('agents') ? flag('agents').split(',') : c.agents;
  const cfg = loadConfig();
  const agent = id => require('./room').resolveAgent(cfg.agents.filter(x => x.type !== 'url'), id);
  const { run } = require('./motion');
  const root = flag('out') ? path.resolve(flag('out')) : path.join(HOME_DIR, 'ideate', `${stamp()}-${crypto.randomBytes(2).toString('hex')}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ideate-'));
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ ...c, agents: ids, setups }, null, 2));
  console.log(`Ideate: ${root}`);
  const ideasFile = path.join(root, 'ideas.json');
  const runs = fs.existsSync(ideasFile) ? JSON.parse(fs.readFileSync(ideasFile, 'utf8')) : [];
  const save = () => fs.writeFileSync(ideasFile, JSON.stringify(runs, null, 2));
  const started = new Date().toISOString();
  const t0 = Date.now();

  const ask = async (setup, r, id, pool) => {
    const name = `${setup}-r${r + 1}-${id.replace(/[^\w#-]+/g, '-')}`;
    if (runs.some(x => x.name === name && x.ideas.length)) return;
    const a = agent(id);
    const t = Date.now();
    try {
      const text = await run(root, name, a, askPrompt(c, setup, pool), work);
      runs.push({ name, setup, repeat: r + 1, agent: a.base || id, ideas: parseIdeas(text), seconds: Math.round((Date.now() - t) / 1000), chars: text.length });
    } catch (e) { console.error(`  ✗ ${name}: ${e.message.split('\n')[0]}`); runs.push({ name, setup, repeat: r + 1, agent: a.base || id, ideas: [], error: e.message.split('\n')[0] }); }
    save();
  };
  // Repeat by repeat, agents rotating who goes first (it changes nothing, as they don't see each other, but keeps timing fair).
  for (const setup of setups.filter(s => s !== 'gaps'))
    for (let r = 0; r < c.repeats; r++)
      for (const id of ids.slice(r % ids.length).concat(ids.slice(0, r % ids.length))) await ask(setup, r, id, []);
  if (setups.includes('gaps')) {
    const pool = runs.filter(x => x.setup !== 'gaps').flatMap(x => x.ideas).map(i => ({ idea: anonymise(i.idea), mechanism: anonymise(i.mechanism) }));
    for (let r = 0; r < c.gaps_repeats; r++) for (const id of ids) await ask('gaps', r, id, pool);
  }

  // Number every idea, shuffled so the order says nothing about author or setup.
  const ideas = runs.flatMap(x => x.ideas.map(i => ({ ...i, agent: x.agent, setup: x.setup, repeat: x.repeat })));
  const order = ideas.map((_, k) => k).sort(() => Math.random() - 0.5);
  order.forEach((k, n) => { ideas[k].n = n + 1; });
  ideas.sort((a, b) => a.n - b.n);
  fs.writeFileSync(path.join(root, 'numbered.json'), JSON.stringify(ideas, null, 2));

  const labels = {};
  for (const jid of c.judges) {
    const j = agent(jid);
    labels[j.base || jid] = {};
    for (let b = 0; b < ideas.length; b += 40) {
      try { Object.assign(labels[j.base || jid], parseLabels(await run(root, `label-${jid}-${b / 40 + 1}`, j, labelPrompt(c, ideas.slice(b, b + 40)), work))); }
      catch (e) { console.error(`  ✗ labels ${jid} batch ${b / 40 + 1}: ${e.message.split('\n')[0]}`); }
    }
  }
  fs.writeFileSync(path.join(root, 'labels.json'), JSON.stringify(labels, null, 2));
  let clusters = [];
  try { clusters = parseClusters(await run(root, 'clusters', agent(c.clusterer), clusterPrompt(ideas), work)); }
  catch (e) { console.error(`  ✗ clusters: ${e.message.split('\n')[0]}`); }
  fs.writeFileSync(path.join(root, 'clusters.json'), JSON.stringify(clusters, null, 2));
  const geminiCalls = runs.filter(x => /antigravity/.test(x.agent)).length + c.judges.filter(j => /antigravity/.test(j)).length * Math.ceil(ideas.length / 40);
  let spent = null;
  try { spent = require('./openrouter').spent(started); } catch {}
  fs.writeFileSync(path.join(root, 'summary.md'), summaryMd(c, ideas, labels, clusters) +
    `\n## Cost and time\n\n${Math.round((Date.now() - t0) / 60000)} minutes. Gemini calls: ${geminiCalls} (≈ £${(geminiCalls * 0.03).toFixed(2)}, estimate). OpenRouter reported: $${(spent || 0).toFixed(4)}. Claude and Codex: subscriptions.\n`);
  console.log(`\n${path.join(root, 'summary.md')}`);
}

module.exports = { askPrompt, parseIdeas, anonymise, labelPrompt, parseLabels, clusterPrompt, parseClusters, summaryMd, AFFORDANCES };

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
