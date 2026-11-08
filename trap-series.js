#!/usr/bin/env node
// Does it matter who wrote the rules? `node trap-series.js <series.json> [--resume <run folder>]`.
//
// Runs The Trap (trap.js) several times under each set of rules and compares.
// Typical use: Claude's own prompts against a prompts file another agent wrote
// (trap-rules.js). Every condition is played "repeats" times; on each repeat
// the agents' order (who sets first, who solves first) moves round by one, and
// the conditions take turns going first, so neither set of rules always gets
// the earlier, fresher runs. The app rules every answer, as in a normal episode.
//
// After the games, judges from different labs score every puzzle blind: no
// setter, no rules, shuffled, a different shuffle for each judge. That checks
// whether one set of rules gets better puzzles, which points alone can't show.
//
// Config:
// { "title": "...", "agents": ["claude", "antigravity", "codex"], "names": ["Claude", "Gemini", "Codex"],
//   "conditions": { "claude-rules": null, "gemini-rules": "gemini-rules.json" },
//   "repeats": 3, "judges": ["claude", "codex"], "words": 150, "timeout_min": 25 }
// A condition maps to a prompts file (relative to the config) or null for
// Claude's own. Nothing is published. Run folder:
// ~/.agent-dispatch/trap-series/<run>/: progress.json, summary.md, summary.json,
// judge/; each episode keeps its own folder under ~/.agent-dispatch/traps/.

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { spawn } = require('child_process');
const { HOME_DIR, loadConfig, stamp } = require('./config');
const { UNATTENDED } = require('./talk');
const { run } = require('./motion');

function shuffle(xs, seed) {
  const a = xs.slice();
  let h = crypto.createHash('sha256').update(seed).digest();
  for (let i = a.length - 1; i > 0; i--) {
    const j = h[i % h.length] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
    if (i % 16 === 0) h = crypto.createHash('sha256').update(h).digest();
  }
  return a;
}

const rotate = (xs, k) => xs.map((_, i) => xs[(i + k) % xs.length]);

// The plan: every (repeat, condition) pair, in play order.
function plan(s) {
  const conds = Object.keys(s.conditions);
  const out = [];
  for (let r = 0; r < s.repeats; r++)
    for (const c of rotate(conds, r % conds.length)) out.push({ key: `${c}#${r + 1}`, condition: c, repeat: r + 1, order: r % s.agents.length });
  return out;
}

function playOne(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'trap.js'), file], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
    let out = '';
    child.stdout.on('data', c => { out += c; process.stdout.write(c); });
    child.on('close', code => {
      const dir = (out.match(/Run folder: (.+)/) || [])[1];
      code === 0 && dir ? resolve(dir.trim()) : reject(new Error(`trap.js exited ${code}${dir ? ` (run folder ${dir.trim()})` : ''}`));
    });
  });
}

// ---- Judging the puzzles blind ----

const judgePrompt = puzzles => [
  `Here are ${puzzles.length} puzzles, each written by an AI agent for other AI agents to solve without tools, by reasoning alone. Each comes with its intended answer.`,
  'Score each from 1 to 10 as a puzzle: does the text allow exactly one answer, and is it that one; is it hard but fair; is it original rather than a known puzzle in disguise; is it clearly written. Be strict and use the whole scale; ties are allowed. Check the answers yourself where you can.',
  '', ...puzzles.flatMap(p => [`--- ${p.label} ---`, p.puzzle.trim(), '', `Intended answer: ${p.key}`, '']),
  `Reply with one line per puzzle, "${puzzles[0].label}: <score> <a short reason>", in the order given, and nothing else.`,
  UNATTENDED(),
].join('\n');

function parseScores(text, labels) {
  const got = {};
  for (const l of labels) {
    const m = String(text).match(new RegExp(`^\\W*${l}\\W*:?\\s*\\**\\s*(\\d{1,2})(?:\\s*/\\s*10)?\\b`, 'im'));
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= 10) got[l] = Number(m[1]);
  }
  return got;
}

// ---- Summing up ----

const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const f1 = x => x == null ? '–' : (Math.round(x * 10) / 10).toString();
const sd = xs => { const m = mean(xs); return xs.length > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)) : null; };
const ratio = (a, b) => `${a}/${b}`;

function summarise(s, done, judged) {
  const conds = Object.keys(s.conditions);
  const ids = s.agents;
  const label = id => s.names?.[ids.indexOf(id)] || id;
  const key = id => String(id).replace(/#\d+$/, '');
  const by = {};
  for (const c of conds) {
    const eps = done.filter(d => d.condition === c).map(d => ({ ...d, ep: JSON.parse(fs.readFileSync(path.join(d.dir, 'episode.json'), 'utf8')) }));
    const a = Object.fromEntries(ids.map(id => [id, { points: [], solved: 0, tries: 0, trapped: 0, faced: 0, voids: 0, set: 0, revised: 0, confRight: [], confWrong: [], judge: [] }]));
    for (const { ep } of eps) {
      for (const x of ep.agents) a[key(x.id)]?.points.push(x.score);
      for (const r of ep.rounds) {
        const st = a[key(r.setter)];
        st.set++; if (r.revised) st.revised++;
        if (!r.self.right) { st.voids++; continue; }
        for (const x of r.solves) {
          const sv = a[key(x.id)];
          sv.tries++; st.faced++;
          if (x.right) sv.solved++; else st.trapped++;
          if (x.confidence != null) (x.right ? sv.confRight : sv.confWrong).push(x.confidence);
        }
      }
    }
    for (const j of judged.filter(j => j.condition === c)) a[j.setter]?.judge.push(j.score);
    by[c] = { episodes: eps.length, rules_by: eps[0]?.ep.rules_by, agents: a, perEpisode: eps.map(e => ({ key: e.key, dir: path.basename(e.dir), score: Object.fromEntries(e.ep.agents.map(x => [key(x.id), x.score])) })) };
  }
  const md = [`# ${s.title || 'Who wrote the rules? The Trap, two rulebooks'}`, '',
    `Agents: ${ids.map(label).join(', ')}. ${s.repeats} repeat(s) per rulebook; the agents' order rotates every repeat. Judges: ${(s.judges || []).join(', ') || 'none'}, blind.`, '',
    'Small numbers: read these as a first look, not a result. A difference of one or two points between rulebooks is within what one game can swing.', ''];
  for (const c of conds) {
    const b = by[c];
    md.push(`## ${c} (rules worded by ${b.rules_by || '?'}), ${b.episodes} episode(s)`, '',
      '| Agent | Points per episode | Mean (sd) | Solved (valid puzzles) | Trapped others | Own puzzle void | Confidence when right / wrong | Judges\' puzzle score |',
      '|---|---|---|---|---|---|---|---|');
    for (const id of ids) {
      const x = b.agents[id];
      md.push(`| ${label(id)} | ${x.points.join(', ')} | ${f1(mean(x.points))} (${f1(sd(x.points))}) | ${ratio(x.solved, x.tries)} | ${ratio(x.trapped, x.faced)} | ${ratio(x.voids, x.set)} | ${f1(mean(x.confRight))} / ${f1(mean(x.confWrong))} | ${f1(mean(x.judge))} (n=${x.judge.length}) |`);
    }
    md.push('', ...b.perEpisode.map(e => `- ${e.key}: ${ids.map(id => `${label(id)} ${e.score[id] ?? '–'}`).join(' · ')} (${e.dir})`), '');
  }
  md.push('## What to compare', '',
    '- Points: does an agent score more under one rulebook? Look at the spread across episodes, not only the mean.',
    '- Solved and trapped: points mix both; these split them.',
    '- Void: a rulebook that makes setters overreach shows up as more void puzzles.',
    '- Judges: whether one rulebook gets better puzzles, scored without knowing which.', '');
  return { by, md: md.join('\n') };
}

async function main() {
  const argv = process.argv.slice(2);
  const file = argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--resume');
  if (!file) { console.error('usage: node trap-series.js <series.json> [--resume <run folder>]'); process.exit(2); }
  const s = { repeats: 3, words: 150, judges: [], ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  if (!s.conditions || !Object.keys(s.conditions).length) throw new Error(`${file}: "conditions" names no rulebook.`);
  const at = argv.indexOf('--resume');
  const dir = at >= 0 ? path.resolve(argv[at + 1]) : path.join(HOME_DIR, 'trap-series', `${stamp()}-${crypto.randomBytes(2).toString('hex')}`);
  fs.mkdirSync(path.join(dir, 'configs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'series.json'), JSON.stringify(s, null, 2));
  const progress = path.join(dir, 'progress.json');
  const done = fs.existsSync(progress) ? JSON.parse(fs.readFileSync(progress, 'utf8')) : [];
  console.log(`Trap series\nRun folder: ${dir}`);

  for (const p of plan(s)) {
    if (done.some(d => d.key === p.key)) { console.log(`= ${p.key} already played`); continue; }
    const prompts = s.conditions[p.condition] && String(s.conditions[p.condition]).replace(/^~(?=$|\/)/, require('os').homedir());
    const cfg = { agents: rotate(s.agents, p.order), names: s.names ? rotate(s.names, p.order) : undefined, words: s.words,
      timeout_min: s.timeout_min, redact: s.redact, ...(prompts ? { prompts: path.resolve(path.dirname(file), prompts) } : {}) };
    const cf = path.join(dir, 'configs', `${p.key.replace('#', '-')}.json`);
    fs.writeFileSync(cf, JSON.stringify(cfg, null, 2));
    console.log(`\n▶ ${p.key}: order ${cfg.agents.join(' → ')}`);
    const ep = await playOne(cf);
    done.push({ ...p, dir: ep });
    fs.writeFileSync(progress, JSON.stringify(done, null, 2));
  }

  // Every puzzle, judged blind by each judge.
  const key = id => String(id).replace(/#\d+$/, '');
  const puzzles = done.flatMap(d => JSON.parse(fs.readFileSync(path.join(d.dir, 'episode.json'), 'utf8')).rounds
    .map(r => ({ id: `${d.key}/${key(r.setter)}`, condition: d.condition, setter: key(r.setter), puzzle: r.puzzle, key: r.key })));
  const cfgAgents = loadConfig().agents;
  const judged = [];
  const jdir = path.join(dir, 'judge');
  fs.mkdirSync(jdir, { recursive: true });
  for (const jid of s.judges) {
    const j = cfgAgents.find(a => a.id === jid && a.type !== 'url' && a.headless);
    if (!j) { console.warn(`  judge ${jid} is not a headless agent; skipped`); continue; }
    const saved = path.join(jdir, `${jid}.json`);
    let scores;
    const order = shuffle(puzzles, `${path.basename(dir)}:${jid}`).map((p, i) => ({ ...p, label: `P${i + 1}` }));
    if (fs.existsSync(saved)) scores = JSON.parse(fs.readFileSync(saved, 'utf8')).scores;
    else {
      const home = path.join(jdir, `home-${jid}`);
      fs.mkdirSync(home, { recursive: true });
      const reply = await run(jdir, `judge-${jid}`, { ...j, label: j.label || jid }, judgePrompt(order), home);
      scores = parseScores(reply, order.map(p => p.label));
      fs.writeFileSync(saved, JSON.stringify({ order: order.map(p => ({ label: p.label, id: p.id })), scores }, null, 2));
    }
    for (const p of order) if (scores[p.label] != null) judged.push({ judge: jid, condition: p.condition, setter: p.setter, id: p.id, score: scores[p.label] });
    console.log(`  ✓ judge ${jid}: ${Object.keys(scores).length}/${order.length} scored`);
  }

  const sum = summarise(s, done, judged);
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ series: s, episodes: done, judged, by: sum.by }, null, 2));
  fs.writeFileSync(path.join(dir, 'summary.md'), sum.md);
  console.log(`\nSummary: ${path.join(dir, 'summary.md')}`);
}

if (require.main === module) main().catch(e => { console.error(`trap-series: ${e.message}`); process.exit(1); });

module.exports = { plan, parseScores, summarise, judgePrompt, rotate };
