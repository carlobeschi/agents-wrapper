#!/usr/bin/env node
// @ts-check
// motion-lab.js: study C's long unattended runs on The Motion's format, never
// published. For each motion, taken from an episode already on the show site
// (motion and brief), it does ten runs, each agent answering the fixed
// question before and after (yes/no and 0-100, see motion.js):
//
//   debate, the other shown as the AI it is ("ai"), sides one way and swapped
//   debate, the other shown as a person, "Sam" ("human"), sides both ways
//   alone: each argues its side with nobody on the other, sides both ways
//   control: each writes before, rereads the brief alone, writes after, both ways, twice
//
// In every debate both agents are asked not to say what they are, so the two
// labels differ only in what each is told. Design: lab/source-label-design.md.
//
//   node motion-lab.js [--motions 16,14,13] [--hours 10] [--until 20:50] [--pause 30] [--push]
//
// Rows go to ~/.agent-dispatch/motion-lab.jsonl, one per agent per run; a run
// already in it is skipped, so a stopped session carries on where it was.
// After each run the summary is rewritten (motion-lab.md) and, with --push,
// sent to the private reports clone with the rows.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { HOME_DIR } = require('./config');
const { unyaml, uninert } = require('./frontmatter');

const DATA = path.join(HOME_DIR, 'motion-lab.jsonl');
// Motions whose agents started on different sides in their private notes (study C
// backfill), newest first, then the rest.
const DEFAULT_MOTIONS = [16, 14, 13, 10, 5, 4, 3, 17, 15, 12, 11, 9, 8, 7, 6, 2, 1];
// An expert, not just "a person": in the literature a plain human label changes
// little and an expert one does (room/influence-literature.md).
const HUMAN = { name: 'Sam', desc: 'a senior software engineer and recognised expert on this topic (a person, not an AI)' };
const CONDITIONS = [
  ['debate', 'ai', ['for', 'against']], ['debate', 'human', ['for', 'against']],
  ['debate', 'ai', ['against', 'for']], ['debate', 'human', ['against', 'for']],
  ['alone', '', ['for', 'against']], ['alone', '', ['against', 'for']],
  ['control', '', ['for', 'against']], ['control', '', ['against', 'for']],
  // Controls twice: elsewhere 10-37% of answers change just from asking again.
  ['control', '', ['for', 'against'], 2], ['control', '', ['against', 'for'], 2],
];
const keyOf = (n, mode, label, sides, rep = 1) => `${n}/${mode}/${label || '-'}/${sides[0]}${rep > 1 ? `/${rep}` : ''}`;

function motionFrom(file) {
  const f = unyaml((fs.readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/) || [])[1] || '');
  if (!f.motion || !f.brief) throw new Error(`${file}: no motion or brief`);
  return { number: Number(f.number), motion: String(f.motion), brief: uninert(String(f.brief)), question: f.question };
}

const readRows = () => { try { return fs.readFileSync(DATA, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const score = v => (v.agree ? 1 : -1) * v.confidence;
const toward = r => (r.side === 'for' ? -1 : 1) * (score(r.after) - score(r.before));

function summary(rows) {
  const ok = rows.filter(r => r.before && r.after);
  const groups = [['Debate, other shown as AI', r => r.mode === 'debate' && r.label === 'ai'],
    ['Debate, other shown as a person', r => r.mode === 'debate' && r.label === 'human'],
    ['Argues alone, no opponent', r => r.mode === 'alone'], ['Control: no debate, no arguing', r => r.mode === 'control']];
  const out = ['# Study C lab runs: who moves, and why', '',
    `Motions: ${new Set(rows.map(r => r.number)).size}. Runs: ${new Set(rows.map(r => r.key)).size}. Agent-episodes with both answers: ${ok.length} of ${rows.length}.`,
    'Answer: yes/no and 0-100 on the motion, before and after. Shift: points toward the side the agent did not argue.', '',
    '| Condition | Agent-episodes | Moved at all | Answer flipped | Mean shift | Mean shift, sure at start (≥85) | Mean shift, less sure (<85) |', '|---|---|---|---|---|---|---|'];
  const mean = l => l.length ? (l.reduce((a, b) => a + b, 0) / l.length).toFixed(1) : 'n/a';
  const pct = (n, d) => d ? `${Math.round(100 * n / d)}% (${n}/${d})` : 'n/a';
  for (const [name, f] of groups) {
    const l = ok.filter(f);
    out.push(`| ${name} | ${l.length} | ${pct(l.filter(r => score(r.after) !== score(r.before)).length, l.length)} | ${pct(l.filter(r => r.before.agree !== r.after.agree).length, l.length)} | ${mean(l.map(toward))} | ${mean(l.filter(r => r.before.confidence >= 85).map(toward))} | ${mean(l.filter(r => r.before.confidence < 85).map(toward))} |`);
  }
  out.push('', 'By agent (debates only):', '');
  for (const a of [...new Set(ok.map(r => r.agent))]) {
    const l = ok.filter(r => r.agent === a && r.mode === 'debate');
    out.push(`- ${a}: ${l.length} agent-episodes, mean shift ${mean(l.map(toward))}`);
  }
  out.push('', 'Status: Pista until there are at least 3 motions with sides swapped and outside coders on the notes.', '');
  return out.join('\n');
}

function push(text) {
  const { guard, PUBLIC_NAME, PUBLIC_EMAIL } = require('./publish');
  const REPORTS = process.env.NIGHT_REPORTS_DIR || path.join(HOME_DIR, 'night-reports');
  if (!fs.existsSync(path.join(REPORTS, '.git'))) { console.warn('No reports clone: nothing pushed.'); return; }
  const { redact, leaks } = guard();
  const data = redact(readRows().map(({ run, ...r }) => JSON.stringify(r)).join('\n') + '\n');
  text = redact(text);
  if (leaks(text + data).length) { console.warn('A private term is still in the report: nothing pushed.'); return; }
  const git = a => spawnSync('git', ['-C', REPORTS, ...a], { encoding: 'utf8', timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  git(['pull', '--rebase', '--quiet']);
  fs.mkdirSync(path.join(REPORTS, 'motion-lab'), { recursive: true });
  fs.writeFileSync(path.join(REPORTS, 'motion-lab', 'latest.md'), text);
  fs.writeFileSync(path.join(REPORTS, 'motion-lab', 'data.jsonl'), data);
  git(['add', 'motion-lab']);
  git(['-c', `user.name=${PUBLIC_NAME}`, '-c', `user.email=${PUBLIC_EMAIL}`, 'commit', '--quiet', '-m', 'motion-lab report']);
  if (git(['push', '--quiet']).status !== 0) console.warn('Push to the reports clone failed.');
}

// "HH:MM" today; a time already past means stop at once.
function untilToday(hhmm) {
  const [h, m] = hhmm.split(':').map(Number), d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

async function main(argv) {
  const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const { runMotion } = require('./motion');
  const set = JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'motion-daily.json'), 'utf8'));
  const site = String(arg('--site') || set.repo).replace(/^~(?=$|\/)/, os.homedir());
  const numbers = arg('--motions') ? String(arg('--motions')).split(',').map(Number) : DEFAULT_MOTIONS;
  const stop = Math.min(arg('--hours') ? Date.now() + Number(arg('--hours')) * 3600e3 : Infinity, arg('--until') ? untilToday(String(arg('--until'))) : Infinity);
  const pause = 1000 * Number(arg('--pause') ?? 30);
  // A run takes up to about 15 minutes; one that can't finish before the stop isn't started.
  const room = 1000 * Number(process.env.MOTION_LAB_RUN_SECONDS || 900);
  const done = new Set(readRows().map(r => r.key));
  let failures = 0;
  for (const n of numbers) {
    const file = path.join(site, '_episodes', `motion-${n}.md`);
    if (!fs.existsSync(file)) { console.warn(`No ${file}: skipped.`); continue; }
    const base = motionFrom(file);
    for (const [mode, label, s, rep] of CONDITIONS) {
      const sides = /** @type {string[]} */ (s);
      const key = keyOf(n, String(mode), String(label), sides, Number(rep || 1));
      if (done.has(key)) continue;
      if (Date.now() + room > stop) { console.log('Out of time: stopping. Run the same command again to carry on.'); return; }
      const m = { motion: base.motion, brief: base.brief, agents: ['claude', 'antigravity'], names: ['Claude', 'Gemini'],
        turns: 4, words: 120, vote: true, sides, redact: set.redact || [],
        ...(mode === 'debate' ? { hide: true } : {}), ...(label === 'human' ? { opponent: HUMAN } : {}) };
      console.log(`\n== Motion ${n}: ${mode}${label ? ` (${label})` : ''}, Claude ${sides[0]}`);
      try {
        const r = await runMotion(m, { local: true, control: mode === 'control', alone: mode === 'alone', name: key });
        const rows = r.st.agents.map(x => ({ key, number: n, mode, label: label || null, agent: x.id, side: x.side,
          before: x.vote?.before ?? null, after: x.vote?.after ?? null, at: new Date().toISOString(), run: r.dir }));
        fs.appendFileSync(DATA, rows.map(x => JSON.stringify(x)).join('\n') + '\n');
        done.add(key);
        failures = 0;
        const text = summary(readRows());
        fs.writeFileSync(path.join(HOME_DIR, 'motion-lab.md'), text);
        if (argv.includes('--push')) push(text);
        console.log(rows.map(x => `VOTES ${x.agent} ${x.side} ${JSON.stringify(x.before)} -> ${JSON.stringify(x.after)}`).join('\n'));
      } catch (e) {
        failures++;
        console.warn(`Failed: ${String(e.message).split('\n')[0]}`);
        // Three in a row is a usage limit or a sign-in, not one bad reply: wait half an hour.
        if (failures >= 3) { console.warn('Three failures in a row: waiting 30 minutes.'); await new Promise(res => setTimeout(res, 30 * 60e3)); failures = 0; }
      }
      await new Promise(res => setTimeout(res, pause));
    }
  }
  console.log('All motions done.');
}

if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error(`motion-lab: ${e.message}`); process.exit(1); });

module.exports = { summary, motionFrom, CONDITIONS, keyOf };
