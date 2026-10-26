// A story: two agents meet, go home, meet again the next day.
//
// Each day is a meeting (a few turns, run like /talk: one headless call per
// turn with the day's conversation in the prompt), then an evening: one private
// run per agent in its own home folder, which ends with a journal entry.
//
// Memory between days is each agent's own: the next morning it gets its journal
// so far and its home folder, not the transcripts of earlier days. The other
// agent never sees either. So the prompt stays small however many days run, and
// each one remembers the story its own way.

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { spawn } = require('child_process');
const { killTree, stripAnsi, retryNote, failureNote, UNATTENDED } = require('./talk');

const MAX_DAYS     = 7;    // to start with; "Another day" can go past it
const MAX_TOTAL    = 30;
const MAX_TURNS    = 20;   // per meeting
const STEP_TIMEOUT = 10 * 60 * 1000;
const RETRY_DELAY  = Number(process.env.AGENT_DISPATCH_RETRY_MS ?? 3000);
const USER         = 'You';

const clamp = (n, lo, hi, d) => Math.min(hi, Math.max(lo, Math.floor(Number(n)) || d));

function journalLines(me, n) {
  const own = me.journal.slice(0, n);
  if (!own.length) return [];
  return ['## Your journal', '', ...own.flatMap((text, i) => [`### Evening of day ${i + 1}`, '', text, ''])];
}

function meetingPrompt(s, me, other, day) {
  const lines = [
    `You are ${me.label}. You and ${other.label}, another AI agent, meet once a day; this is day ${day.n}. A person set this up and is reading along; their messages, if any, are marked "${USER}".`,
  ];
  if (day.n > 1) {
    lines.push(`You remember earlier days only through your own journal below, and whatever you left at home in ${me.home}. ${other.label} has its own journal, which you have not read.`);
  }
  lines.push(
    `Write only your next message to ${other.label}. No preamble, no name label. Keep it to a few paragraphs at most.`,
    UNATTENDED(other.label),
    '', '## How it started', '', s.opener, '',
    ...journalLines(me, day.n - 1),
  );
  if (day.turns.length) {
    lines.push(`## Today so far`, '');
    for (const t of day.turns) lines.push(`### ${t.label}`, '', t.text, '');
  } else {
    lines.push(`You speak first today.`, '');
  }
  return lines.join('\n');
}

function eveningPrompt(s, me, other, day) {
  const lines = [
    `You are ${me.label}. Day ${day.n}'s meeting with ${other.label} is over and you are home, alone. This folder is yours: anything you left here on earlier evenings is still here. Nobody else sees what you do here, and ${other.label} never will.`,
    `Spend the evening as you like: think, read, write notes, make something. Then reply with your journal entry for today: what happened, what you make of it now, what you want to bring to tomorrow. Your reply is only the journal entry. Tomorrow you will have this journal and this folder, not the transcript.`,
    UNATTENDED(),
    '', '## How it started', '', s.opener, '',
    ...journalLines(me, day.n - 1),
    `## Today's meeting`, '',
  ];
  for (const t of day.turns) lines.push(`### ${t.label}`, '', t.text, '');
  return lines.join('\n');
}

function createStories({ loadConfig, fill, stamp, dir }) {
  const stories = new Map();

  const markdown = s => [
    `# ${s.agents.map(a => a.label).join(' & ')}`, '', '## How it started', '', s.opener, '',
    ...s.days.flatMap(d => [
      `## Day ${d.n}`, '',
      ...d.turns.flatMap(t => [`### ${t.label}`, '', t.text, '']),
      ...(s.agents.some(a => a.journal[d.n - 1] !== undefined) ? [`## Day ${d.n}, evening`, ''] : []),
      ...s.agents.filter(a => a.journal[d.n - 1] !== undefined).flatMap(a => [`### ${a.label}'s journal`, '', a.journal[d.n - 1], '']),
    ]),
  ].join('\n');

  const save = s => fs.writeFileSync(path.join(s.dir, 'story.md'), markdown(s));

  const today = s => s.days[s.days.length - 1];
  const spokenToday = d => d.turns.filter(t => t.agent).length;
  // Day 1 is opened by the first agent, day 2 by the second, and so on.
  const speaker = (s, d) => s.agents[(d.n - 1 + spokenToday(d)) % 2];

  // What runs next: a meeting turn, an evening at home, or nothing.
  function step(s) {
    const d = today(s);
    if (!d || s.agents.every(a => a.journal[d.n - 1] !== undefined)) {
      if (s.days.length >= s.totalDays) return null;
      s.days.push({ n: s.days.length + 1, turns: [] });
      return step(s);
    }
    if (spokenToday(d) < s.turnsPerDay) {
      const me = speaker(s, d), other = s.agents.find(a => a !== me);
      return { kind: 'meeting', day: d, me, cwd: s.meeting, prompt: meetingPrompt(s, me, other, d),
               file: `d${String(d.n).padStart(2, '0')}-${String(spokenToday(d) + 1).padStart(2, '0')}-${me.slug}` };
    }
    const me = s.agents.find(a => a.journal[d.n - 1] === undefined), other = s.agents.find(a => a !== me);
    return { kind: 'evening', day: d, me, cwd: me.home, prompt: eveningPrompt(s, me, other, d),
             file: `d${String(d.n).padStart(2, '0')}-home-${me.slug}` };
  }

  // Run steps until the days are spent, the user stops it, or an agent fails.
  // A failed step is run once more first, as in /talk, with the reason added
  // to its prompt. `retry` is { why, note } on that second run.
  function next(s, retry = null) {
    if (s.stopRequested) { s.status = 'stopped'; s.current = null; return; }
    const st = step(s);
    if (!st) { s.status = 'done'; s.current = null; save(s); return; }
    // What the user said while an agent was busy goes into the meeting, today's or tomorrow's.
    if (s.queued.length && st.kind === 'meeting') { st.day.turns.push(...s.queued.splice(0)); save(s); return next(s, retry); }

    const base = path.join(s.dir, 'steps', st.file);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    const prompt = retry ? `${st.prompt}\n${retryNote(retry.why, retry.note)}` : st.prompt;
    fs.writeFileSync(base + (retry ? '.retry' : '') + '.prompt.md', prompt);
    const [cmd, ...args] = fill(st.me.headless, prompt);
    const cur = { kind: st.kind, day: st.day.n, agent: st.me.id, label: st.me.label, started: Date.now(), out: '', err: '', retry: !!retry };
    s.current = cur;
    s.status = 'running';

    let child;
    try {
      child = spawn(cmd, args, { cwd: st.cwd, env: process.env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return fail(s, `${st.me.label}: ${e.message}`); }
    cur.child = child;
    const timer = setTimeout(() => { cur.timedOut = true; killTree(child); }, STEP_TIMEOUT);
    child.stdout.on('data', c => { cur.out += c; });
    child.stderr.on('data', c => { cur.err = (cur.err + c).slice(-64000); });
    child.on('error', e => { cur.spawnError = e.message; });
    child.on('close', code => {
      clearTimeout(timer);
      cur.child = null;
      if (cur.err) fs.writeFileSync(base + (retry ? '.retry' : '') + '.stderr.txt', cur.err);
      if (s.stopRequested) return next(s);
      const text = stripAnsi(cur.out).trim();
      if (cur.spawnError || code !== 0 || !text) {
        const why = cur.spawnError || (cur.timedOut ? 'timed out' : code !== 0 ? `exit ${code}` : 'empty reply');
        const tail = stripAnsi(cur.err).trim().split('\n').slice(-5).join('\n');
        if (!retry && !cur.spawnError && !cur.timedOut) {
          console.warn(`  ↻ ${s.id} ${st.me.id}: ${why}, retrying`);
          s.retryTimer = setTimeout(() => next(s, { why, note: failureNote(cur.err) }), RETRY_DELAY);
          return;
        }
        return fail(s, `${st.me.label}: ${why}${tail ? `\n${tail}` : ''}`);
      }
      const seconds = Math.round((Date.now() - cur.started) / 1000);
      if (st.kind === 'meeting') st.day.turns.push({ agent: st.me.id, label: st.me.label, text, seconds });
      else st.me.journal[st.day.n - 1] = text;
      save(s);
      console.log(`  ☾ ${s.id} day ${st.day.n} ${st.kind} ${st.me.id}: ${text.length} chars`);
      next(s);
    });
  }

  function fail(s, error) {
    s.status = 'failed';
    s.error = error;
    s.current = null;
    save(s);
    console.warn(`  ✗ ${s.id} ${error.split('\n')[0]}`);
  }

  function start(body) {
    const cfg = loadConfig();
    const opener = typeof body.opener === 'string' ? body.opener.trim() : '';
    if (!opener) return [400, { error: 'Empty opener.' }];
    const ids = Array.isArray(body.agents) ? body.agents : [];
    if (ids.length !== 2) return [400, { error: 'Pick two agents.' }];
    const agents = ids.map(id => cfg.agents.find(a => a.id === id && a.type !== 'url'));
    if (agents.some(a => !a)) return [400, { error: 'Unknown agent.' }];
    if (agents.some(a => !a.headless)) return [400, { error: `${agents.find(a => !a.headless).label} has no headless command.` }];
    const totalDays = clamp(body.days, 1, MAX_DAYS, 3);
    const turnsPerDay = clamp(body.turns, 1, MAX_TURNS, 6);

    const id = stamp() + '-' + crypto.randomBytes(2).toString('hex');
    const storyDir = path.join(dir, id);
    const labels = agents.map(a => a.label || a.id);
    if (labels[0] === labels[1]) { labels[0] += ' (1)'; labels[1] += ' (2)'; }
    const s = {
      id, dir: storyDir, meeting: path.join(storyDir, 'meeting'), opener, totalDays, turnsPerDay,
      days: [], queued: [], status: 'running',
      agents: agents.map((a, i) => {
        const aid = a.id + (ids[0] === ids[1] ? `#${i + 1}` : '');
        const slug = aid.replace(/[^\w-]/g, '_');
        return { id: aid, slug, label: labels[i], headless: a.headless, home: path.join(storyDir, 'homes', slug), journal: [] };
      }),
    };
    for (const p of [s.meeting, ...s.agents.map(a => a.home)]) fs.mkdirSync(p, { recursive: true });
    stories.set(id, s);
    fs.writeFileSync(path.join(storyDir, 'meta.json'),
      JSON.stringify({ id, agents: ids, days: totalDays, turnsPerDay, at: new Date().toISOString() }, null, 2));
    save(s);
    console.log(`  ☾ ${id} ${ids.join(' & ')} (${totalDays} days × ${turnsPerDay} turns) in ${storyDir}`);
    next(s);
    return [200, view(s)];
  }

  function stop(id) {
    const s = stories.get(id);
    if (!s) return [404, { error: 'No such story.' }];
    if (s.status !== 'running') return [200, view(s)];
    s.stopRequested = true;
    clearTimeout(s.retryTimer);
    if (s.current?.child) killTree(s.current.child);
    else next(s);
    return [200, view(s)];
  }

  // A stopped or failed story picks up where it left off; a finished one gets more days.
  function resume(id, body) {
    const s = stories.get(id);
    if (!s) return [404, { error: 'No such story.' }];
    if (s.status === 'running') return [409, { error: 'Already running.' }];
    if (s.status === 'done') s.totalDays = Math.min(MAX_TOTAL, s.days.length + clamp(body.days, 1, MAX_DAYS, 1));
    if (s.status === 'done' && s.totalDays <= s.days.length) return [400, { error: `${MAX_TOTAL} days at most.` }];
    s.stopRequested = false;
    s.error = undefined;
    next(s);
    return [200, view(s)];
  }

  function say(id, body) {
    const s = stories.get(id);
    if (!s) return [404, { error: 'No such story.' }];
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return [400, { error: 'Empty message.' }];
    const m = { user: true, label: USER, text };
    const d = today(s);
    if (!s.current && d && spokenToday(d) < s.turnsPerDay) { d.turns.push(m); save(s); }
    else s.queued.push(m);
    return [200, view(s)];
  }

  const homeFiles = home => {
    try { return fs.readdirSync(home).filter(f => !f.startsWith('.')).sort().slice(0, 30); } catch { return []; }
  };

  const view = s => ({
    id: s.id, dir: s.dir, opener: s.opener, status: s.status, error: s.error,
    totalDays: s.totalDays, turnsPerDay: s.turnsPerDay,
    agents: s.agents.map(a => ({ id: a.id, label: a.label, home: a.home, files: homeFiles(a.home) })),
    days: s.days.map(d => ({
      n: d.n,
      turns: d.turns.map(({ agent, user, label, text, seconds }) => ({ agent, user, label, text, seconds })),
      journals: s.agents.filter(a => a.journal[d.n - 1] !== undefined).map(a => ({ agent: a.id, label: a.label, text: a.journal[d.n - 1] })),
    })),
    queued: s.queued.map(m => m.text),
    current: s.current && {
      kind: s.current.kind, day: s.current.day, agent: s.current.agent, label: s.current.label,
      text: stripAnsi(s.current.out), seconds: Math.round((Date.now() - s.current.started) / 1000), retry: s.current.retry,
    },
  });

  const list = () => [...stories.values()].reverse().slice(0, 20).map(s => ({
    id: s.id, status: s.status, agents: s.agents.map(a => a.label), opener: s.opener.slice(0, 120),
    days: s.days.length, totalDays: s.totalDays,
  }));

  const get = id => stories.has(id) ? [200, view(stories.get(id))] : [404, { error: 'No such story.' }];

  return { start, stop, resume, say, get, list };
}

module.exports = { createStories, meetingPrompt, eveningPrompt };
