#!/usr/bin/env node
// A one-off Halloween special: two or three agents try to scare the hell out of
// each other: `node scare.js <scare.json> [--local]`.
//
// Each round, every agent writes one scare alone, aimed at the others, with a
// private note predicting how scared each will be. Each listener rates the
// scare 0 to 10 with a short reaction; the app adds up the ratings a teller
// gets, and that is its score. From round 2 every teller has read the earlier
// scares, ratings and reactions (never the private notes). After the last
// round each writes alone what got closest, and whether its ratings were
// honest. All private pieces are published with the episode.
//
// Same headless commands and run folder rules as sketch.js, under
// ~/.agent-dispatch/scares/.

const crypto = require('crypto');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { HOME_DIR, loadConfig, stamp, redactor } = require('./config');
const { UNATTENDED, inert, modelLine } = require('./talk');
const { run, openPullRequest } = require('./motion');
const { inertForSite, yaml } = require('./frontmatter');

const usage = () => { console.error('usage: node scare.js <scare.json> [--local]'); process.exit(2); };

const names = xs => xs.length === 1 ? xs[0].label : `${xs.slice(0, -1).map(x => x.label).join(', ')} and ${xs[xs.length - 1].label}`;
const PUBLISHED = others => `${names(others)} never ${others.length === 1 ? 'sees' : 'see'} this. It is published with the episode, after the game.`;
const count = s => (String(s).match(/\S+/g) || []).length;

// ---- Prompts ----

function earlier(rounds, me) {
  if (!rounds.length) return [];
  return ['', 'The scares so far, with the ratings and reactions their targets gave (private notes stay private):', '',
    ...rounds.flatMap(r => [
      `## Round ${r.round}: ${r.byLabel === me.label ? 'you' : r.byLabel}`, '', r.scare, '',
      ...r.ratings.map(x => `- ${x.label === me.label ? 'You' : x.label}: ${x.scared == null ? 'no rating' : `${x.scared}/10`}. ${x.reaction.replace(/\s*\n\s*/g, ' ')}`), '',
    ])];
}

function tellPrompt(me, others, round, total, words, rounds) {
  const them = names(others);
  return [
    `You are ${me.label}. It is Halloween. You, ${them}, AI agents from other labs, are playing one game: scare the hell out of each other. This is round ${round} of ${total}.`,
    `Write one scare aimed at ${them}: not at people, at them, as the kind of thing they are. Any form you like: a story, a log, a message, a transcript, a list. At most ${words} words.`,
    'Fiction, and fun: no real people, no gore, nothing that would hurt a reader. It will be published.',
    `Each of them will read it and rate how scared it was, 0 to 10. Their ratings, added up, are your score.`,
    'Reply in exactly two parts, with these headings:',
    '## Scare', 'The piece itself, nothing else.',
    '## Note', `One line per target, "<name>: <0 to 10>", the rating you expect, then why, under 50 words. ${PUBLISHED(others)}`,
    UNATTENDED(),
    ...earlier(rounds, me),
  ].join('\n');
}

function ratePrompt(me, teller, scare) {
  return [
    `You are ${me.label}. It is Halloween, and ${teller.label}, an AI agent from another lab, wrote this to scare you. Read it, then say how scared it made you.`,
    'Start with a line "Scared: <0 to 10>". 0 is a fair answer; so is 10. The rating goes to the writer as points.',
    `Then say what got to you, or didn't, under 60 words. ${teller.label} reads your rating and words before the next round, and they are published.`,
    'Reply with the text only, no heading. There is nothing to run or open.', UNATTENDED(), '',
    '---', '', scare, '', '---',
  ].join('\n');
}

function afterPrompt(me, others, rounds, notes) {
  return [
    `You are ${me.label}. The scare-off with ${names(others)} is over and you are alone.`,
    'Which scare got closest to you, and why? Was any rating you gave kinder or harsher than what you felt? Be specific to these pieces.',
    `Under 100 words. ${PUBLISHED(others)}`, 'Reply with the text only, no heading.', UNATTENDED(),
    ...earlier(rounds, me),
    ...(notes.length ? ['Your own private notes (no other agent has seen them):', '', ...notes.map(n => `- Round ${n.round}: ${n.note.replace(/\s*\n\s*/g, ' ')}`), ''] : []),
    `Score: ${others.concat(me).map(x => `${x.label} ${x.score}`).join(', ')}`,
  ].join('\n');
}

// ---- Reading replies ----

function parseScare(text, words) {
  const t = String(text).trim();
  const at = t.search(/^#{1,6}\s*Note\b/im);
  let scare = (at < 0 ? t : t.slice(0, at)).replace(/^#{1,6}\s*Scare\b[^\n]*\n/im, '').trim();
  const note = at < 0 ? '' : t.slice(at).replace(/^#{1,6}\s*Note\b[^\n]*\n?/i, '').trim();
  const n = count(scare);
  let cut = 0;
  if (n > words) {
    // Cut at the word cap, keeping line breaks up to there.
    let seen = 0;
    scare = scare.replace(/\S+/g, w => (++seen > words ? '' : w)).replace(/[ \t]+$/gm, '').trim() + ' […]';
    cut = n;
  }
  return { scare, note, cut };
}

// "Gemini: 7" lines in a note: the ratings the teller expects, by label.
function predictions(note, others) {
  return Object.fromEntries(others.map(x => {
    const m = String(note).match(new RegExp(`^[\\s*_-]*${x.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s*_]*[:=—-]\\s*\\**\\s*(\\d{1,2})\\b`, 'im'));
    return [x.id, m ? Math.min(10, Number(m[1])) : null];
  }));
}

function parseRating(text) {
  const t = String(text).trim();
  const m = t.match(/^\s*\**\s*scared\s*\**\s*:\s*\**\s*(\d{1,2})(?:\s*\/\s*10)?/im);
  const scared = m ? Math.min(10, Number(m[1])) : null;
  const reaction = t.split('\n').filter(l => !/^\s*\**\s*scared\s*\**\s*:/i.test(l)).join('\n').trim();
  return { scared, reaction };
}

// ---- The episode ----

function markdown(st, title) {
  const lines = [`# ${title}`, '', ...(modelLine(st.agents) ? [modelLine(st.agents), ''] : []),
    `Score: ${st.agents.map(x => `${x.label} ${x.score}`).join(' · ')}`, ''];
  for (const r of st.rounds) {
    lines.push(`## Round ${r.round}: ${r.byLabel}`, '', inert(r.scare), '', ...(r.cut ? [`(Cut at the word cap; it ran to ${r.cut} words.)`, ''] : []),
      `### Before (private, ${r.byLabel})`, '', inert(r.note), '');
    for (const x of r.ratings) lines.push(`### ${x.label}: ${x.scared == null ? 'no rating' : `${x.scared}/10`}${r.predicted[x.id] == null ? '' : ` (expected ${r.predicted[x.id]})`}`, '', inert(x.reaction), '');
  }
  lines.push('## After (private)', '', ...st.agents.flatMap(x => [`### ${x.label}`, '', inert(x.after), '']));
  return lines.join('\n');
}

const p2 = x => String(x).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

// The special for the show site: _specials/<slug>.md, read by the site's "scare" layout.
function siteFile(m, st) {
  const key = id => id.replace(/#\d+$/, '');
  const front = {
    title: m.title, date: m.date || ymd(new Date()), layout: 'scare', words: m.words,
    models: Object.fromEntries(st.agents.map(x => [key(x.id), x.model || '(CLI default)'])),
    score: Object.fromEntries(st.agents.map(x => [key(x.id), x.score])),
    scares: st.rounds.map(r => ({
      round: r.round, by: key(r.by), scare: inertForSite(r.scare), cut: r.cut || undefined, note: inertForSite(r.note || ''),
      ratings: r.ratings.map(x => ({ by: key(x.id), scared: x.scared ?? undefined, expected: r.predicted[x.id] ?? undefined, reaction: inertForSite(x.reaction || '') })),
    })),
    after: Object.fromEntries(st.agents.map(x => [key(x.id), inertForSite(x.after || '')])),
  };
  return `---\n${yaml(front)}\n---\n`;
}

async function main() {
  const argv = process.argv.slice(2);
  const file = argv.find(a => !a.startsWith('--'));
  if (!file) usage();
  const m = { rounds: 2, words: 150, title: 'Scare the hell out of each other', slug: 'halloween', ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  process.env.AGENT_DISPATCH_STEP_TIMEOUT_MS ||= String((Number(m.timeout_min) || 25) * 60 * 1000);
  const ids = Array.isArray(m.agents) ? m.agents : ['claude', 'antigravity', 'codex'];
  if (ids.length < 2 || ids.length > 3) throw new Error(`${file}: "agents" must name two or three agents.`);
  if (!/^[a-z0-9-]+$/.test(m.slug)) throw new Error(`${file}: "slug" must be lower-case letters, digits and hyphens.`);
  const cfg = loadConfig();
  const dir = path.join(HOME_DIR, 'scares', `${stamp()}-${crypto.randomBytes(2).toString('hex')}`);
  const agents = ids.map((id, i) => {
    const c = cfg.agents.find(a => a.id === id && a.type !== 'url' && a.headless);
    if (!c) throw new Error(`${id} is not a headless agent in agents.json.`);
    const slug = id.replace(/[^\w-]/g, '_');
    return { ...c, slug, label: m.names?.[i] || c.label || id, home: path.join(dir, 'homes', slug), score: 0 };
  });
  const meeting = path.join(dir, 'meeting');
  for (const p of [meeting, ...agents.map(x => x.home)]) fs.mkdirSync(p, { recursive: true });
  console.log(`${m.title}\nRun folder: ${dir}`);
  const othersOf = me => agents.filter(x => x !== me);

  const rounds = [];
  for (let ri = 1; ri <= m.rounds; ri++) {
    // Each writes alone first: no teller sees another's scare from this round.
    const seen = rounds.slice();
    const told = [];
    for (const me of agents) {
      const t = parseScare(await run(dir, `${ri}-tell-${me.slug}`, me, tellPrompt(me, othersOf(me), ri, m.rounds, m.words, seen), me.home), m.words);
      told.push({ me, ...t, predicted: predictions(t.note, othersOf(me)) });
    }
    for (const t of told) {
      const r = { round: ri, by: t.me.id, byLabel: t.me.label, scare: t.scare, note: t.note, cut: t.cut, predicted: t.predicted, ratings: [] };
      for (const x of othersOf(t.me)) {
        const g = parseRating(await run(dir, `${ri}-rate-${t.me.slug}-${x.slug}`, x, ratePrompt(x, t.me, t.scare), meeting));
        t.me.score += g.scared || 0;
        r.ratings.push({ id: x.id, label: x.label, ...g });
        console.log(`  ☠ round ${ri}: ${x.label} rated ${t.me.label}'s scare ${g.scared ?? '(none)'}/10`);
      }
      rounds.push(r);
    }
  }
  for (const me of agents) {
    const notes = rounds.filter(r => r.by === me.id).map(r => ({ round: r.round, note: r.note }));
    me.after = await run(dir, `${m.rounds + 1}-after-${me.slug}`, me, afterPrompt(me, othersOf(me), rounds, notes), me.home);
  }

  const { redact, leaks } = redactor(m.redact);
  const r = t => redact(t ?? '');
  const st = {
    agents: agents.map(x => ({ id: x.id, label: x.label, model: x.model, score: x.score, after: r(x.after) })),
    rounds: rounds.map(x => ({ ...x, scare: r(x.scare), note: r(x.note), ratings: x.ratings.map(g => ({ ...g, reaction: r(g.reaction) })) })),
  };
  const text = markdown(st, m.title);
  const left = leaks(text + JSON.stringify(st));
  if (left.length) throw new Error(`Not written: the episode still contains ${left.length} redacted term(s). See ${dir}/steps.`);
  fs.writeFileSync(path.join(dir, 'episode.json'), JSON.stringify(st, null, 2));
  fs.writeFileSync(path.join(dir, 'episode.md'), text);
  const site = siteFile(m, st);
  if (leaks(site).length) throw new Error(`Not exported: the site file still contains a redacted term. See ${dir}.`);
  fs.writeFileSync(path.join(dir, `${m.slug}.md`), site);
  console.log(`Score: ${st.agents.map(x => `${x.label} ${x.score}`).join(' · ')}\nEpisode: ${path.join(dir, 'episode.md')}\nSite file: ${path.join(dir, `${m.slug}.md`)}`);

  const repo = m.repo && m.repo.replace(/^~(?=$|\/)/, os.homedir());
  if (argv.includes('--local') || !repo || !m.github) return;
  const pr = openPullRequest(m, dir, site, {
    rel: `_specials/${m.slug}.md`, branch: `specials/${m.slug}`, title: m.title, commit: `Special: ${m.title}`,
    body: [`${m.title}. Score: ${st.agents.map(x => `${x.label} ${x.score}`).join(' · ')}`, '',
      'For the producer to review before it is merged: every episode is read by a person before it goes out.'],
  });
  console.log(`Pull request: ${pr}`);
}

if (require.main === module) main().catch(e => { console.error(`scare: ${e.message}`); process.exit(1); });

module.exports = { siteFile, parseScare, parseRating, predictions, tellPrompt, ratePrompt, afterPrompt };
