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
const { parseFiles, saveFiles, withFiles, attachedBytes } = require('./attach');
const { killTree, stripAnsi, retryNote, failureNote, UNATTENDED, refusedTool, skippedText, MAX_REPLY, take, cutAt, cutNote, inert, newTag, untag, heading, SPEAKERS, modelLine } = require('./talk');

const MAX_DAYS     = 7;    // to start with; "Another day" can go past it
const MAX_TOTAL    = 30;
const MAX_TURNS    = 20;   // per meeting
const STEP_TIMEOUT = 10 * 60 * 1000;
const RETRY_DELAY  = Number(process.env.AGENT_DISPATCH_RETRY_MS ?? 3000);
const USER         = 'You';

// Attachments live in the meeting folder. Nothing is written to a home folder,
// which the agent itself can change.
const AWAY = 'at the meeting, not in this folder';

const MAX_DRAWING  = 200 * 1024;
const MAX_NOTES    = 16 * 1024;

// Headless agents can't write files, so what one wants to keep goes at the end
// of its journal under this heading. The app takes it out of the journal, keeps
// it, and puts it in the agent's later prompts. Each evening's notes replace the last.
const NOTES = 'Notes to keep';
const NOTES_RE = new RegExp(`^(?:#{1,6}[ \\t]*)?\\**${NOTES}:?\\**:?[ \\t]*$`, 'im');

function splitNotes(journal) {
  const m = journal.match(NOTES_RE);
  if (!m) return { journal };
  const notes = journal.slice(m.index + m[0].length).trim();
  const rest = journal.slice(0, m.index).trim();
  if (!rest) return { journal };
  return { journal: rest, notes: notes.length > MAX_NOTES ? notes.slice(0, MAX_NOTES) + cutAt(MAX_NOTES) : notes };
}

// The evening reply is a journal entry and, after it, one SVG of the day. Split
// them: the SVG (fenced or bare) becomes the drawing, the rest the journal.
// The page shows it as an <img>, where an SVG cannot run scripts or load anything.
// The saved file can be opened on its own, so a drawing that could run or load
// anything there is dropped, not cleaned: the journal stays, the drawing goes.
const UNSAFE_SVG = [
  /<\s*(script|foreignObject|iframe)\b/i,
  /\son[a-z]+\s*=/i,
  /\b(xlink:)?href\s*=\s*(?!["']#)/i,
  /url\(\s*(?!["']?#)/i,
  /@import/i,
];

function splitDrawing(text) {
  const m = text.match(/```[\w-]*\s*(<svg[\s>][\s\S]*?<\/svg>)\s*```/i) || text.match(/<svg[\s>][\s\S]*?<\/svg>/i);
  if (!m) return { journal: text };
  // An <img> shows an SVG only with its namespace, which a drawing written inline often leaves out.
  const svg = (m[1] || m[0]).replace(/^<svg(?![^>]*\sxmlns=)/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  const journal = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  if (svg.length > MAX_DRAWING || !journal) return { journal: text };
  if (UNSAFE_SVG.some(re => re.test(svg))) return { journal };
  return { journal, svg };
}

const clamp = (n, lo, hi, d) => Math.min(hi, Math.max(lo, Math.floor(Number(n)) || d));

function journalLines(me, n, tag) {
  const own = me.journal.slice(0, n);
  if (!own.length) return [];
  const notes = me.notes.slice(0, n).filter(x => x !== undefined).pop();
  return ['## Your journal', '', ...own.flatMap((text, i) => [heading(`Evening of day ${i + 1}`, tag), '', untag(text, tag), '']),
    ...(notes ? ['## Your notes', '', untag(notes, tag), ''] : [])];
}

// Where this message falls in the day's meeting, so the last one closes it
// instead of leaving a question for tomorrow.
function position(n, total) {
  return n >= total
    ? `This is message ${n} of ${total} today, the last one: bring today's meeting to a close, without a question back.`
    : `This is message ${n} of ${total} today.`;
}

// The opener as one agent reads it: "{partner}" in it is the other agent.
const brief = (s, other) => s.opener.split('{partner}').join(other.label);

function meetingPrompt(s, me, other, day) {
  const lines = [
    `You are ${me.label}. You and ${other.label}, another AI agent, meet once a day; this is day ${day.n} of ${s.of || s.totalDays}. A person set this up and is reading along; their messages, if any, are marked "${USER}".`,
    SPEAKERS(s.tag),
  ];
  if (day.n > 1) {
    lines.push(`You remember earlier days only through your own journal and notes below. ${other.label} has its own, which you have not read.`);
  }
  lines.push(
    `Write only your next message to ${other.label}. No preamble, no name label. Keep it to a few paragraphs at most.`,
    UNATTENDED(other.label),
    position(day.turns.filter(t => t.agent).length + 1, s.turnsPerDay),
    '', '## How it started', '', withFiles(brief(s, other), s.files), '',
    ...journalLines(me, day.n - 1, s.tag),
  );
  if (day.turns.length) {
    lines.push(`## Today so far`, '');
    for (const t of day.turns) lines.push(heading(t.label, s.tag), '', untag(withFiles(t.text, t.files), s.tag), '');
  } else {
    lines.push(`You speak first today.`, '');
  }
  return lines.join('\n');
}

function eveningPrompt(s, me, other, day) {
  const lines = [
    `You are ${me.label}. Day ${day.n}'s meeting with ${other.label} is over and you are home, alone. Nobody else sees what you do here, and ${other.label} never will.`,
    SPEAKERS(s.tag),
    // A story can bring its own brief for the journal ("evening"), and do without the drawing.
    s.evening ? s.evening.split('{partner}').join(other.label)
      : `Spend the evening as you like. Then reply with your journal entry for today: what happened, what you make of it now, what you want to bring to tomorrow. Tomorrow you will have your journal and notes, not the transcript.`,
    `Don't write files: anything you want to keep (lists, drafts, things you made) goes after the entry under a heading "## ${NOTES}". It replaces your notes from earlier evenings, so write out all of it, not just what changed. Leave it out to keep yesterday's notes as they are.`,
    s.drawing === false
      ? `Your reply is the journal entry, then any notes, nothing else.`
      : `After the entry and any notes, draw a picture of what the day looked like: one self-contained SVG, written straight into your reply (not to a file), in an \`\`\`svg block. Shapes, colour and text only; no scripts, links or external images. Your reply is the journal entry, then any notes, then the drawing, nothing else.`,
    UNATTENDED(),
    '', '## How it started', '', withFiles(brief(s, other), s.files, AWAY), '',
    ...journalLines(me, day.n - 1, s.tag),
    `## Today's meeting`, '',
  ];
  for (const t of day.turns) lines.push(heading(t.label, s.tag), '', untag(withFiles(t.text, t.files, AWAY), s.tag), '');
  return lines.join('\n');
}

function createStories({ loadConfig, fill, agentEnv, stamp, dir }) {
  const stories = new Map();

  const markdown = s => [
    `# ${s.agents.map(a => a.label).join(' & ')}`, '', ...(modelLine(s.agents) ? [modelLine(s.agents), ''] : []), '## How it started', '', withFiles(s.opener, s.files), '',
    ...s.days.flatMap(d => [
      `## Day ${d.n}`, '',
      ...d.turns.flatMap(t => [`### ${t.label}`, '', withFiles(inert(t.text), t.files), '']),
      ...(s.agents.some(a => a.journal[d.n - 1] !== undefined) ? [`## Day ${d.n}, evening`, ''] : []),
      ...s.agents.filter(a => a.journal[d.n - 1] !== undefined).flatMap(a => [`### ${a.label}'s journal`, '', inert(a.journal[d.n - 1]), '',
        ...(a.notes[d.n - 1] !== undefined ? [`#### ${a.label}'s notes`, '', inert(a.notes[d.n - 1]), ''] : []),
        ...(a.drawings[d.n - 1] ? [`![${a.label}, day ${d.n}](${a.drawings[d.n - 1].file})`, ''] : [])]),
    ]),
  ].join('\n');

  // state.json is everything needed to pick the story up in another process
  // (season.js runs one day a day); what comes from agents.json is read again then.
  const state = s => ({
    id: s.id, tag: s.tag, opener: s.opener, files: s.files, totalDays: s.totalDays, of: s.of, turnsPerDay: s.turnsPerDay,
    evening: s.evening, drawing: s.drawing, days: s.days, queued: s.queued, status: s.status, error: s.error,
    agents: s.agents.map(({ id, slug, label, model, journal, notes, drawings }) => ({ id, slug, label, model, journal, notes, drawings })),
  });

  const save = s => {
    fs.writeFileSync(path.join(s.dir, 'story.md'), markdown(s));
    fs.writeFileSync(path.join(s.dir, 'state.json'), JSON.stringify(state(s), null, 2));
  };

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
    const [cmd, ...args] = fill(st.me.headless, prompt, st.me.model);
    const cur = { kind: st.kind, day: st.day.n, agent: st.me.id, label: st.me.label, started: Date.now(), out: '', err: '', retry: !!retry,
                  // An evening reply carries a drawing too, which never goes back into a prompt.
                  max: st.kind === 'evening' ? MAX_REPLY + MAX_DRAWING : MAX_REPLY };
    s.current = cur;
    s.status = 'running';

    let child;
    try {
      child = spawn(cmd, args, { cwd: st.cwd, env: agentEnv(st.me.env), shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return fail(s, `${st.me.label}: ${e.message}`); }
    cur.child = child;
    const timer = setTimeout(() => { cur.timedOut = true; killTree(child); }, STEP_TIMEOUT);
    child.stdout.on('data', c => take(cur, c));
    child.stderr.on('data', c => { cur.err = (cur.err + c).slice(-64000); });
    child.on('error', e => { cur.spawnError = e.message; });
    child.on('close', code => {
      clearTimeout(timer);
      cur.child = null;
      if (cur.err) fs.writeFileSync(base + (retry ? '.retry' : '') + '.stderr.txt', cur.err);
      if (s.stopRequested) return next(s);
      const text = stripAnsi(cur.out).trim() && stripAnsi(cur.out).trim() + cutNote(cur);
      if (cur.spawnError || code !== 0 || !text) {
        const why = cur.spawnError || (cur.timedOut ? 'timed out' : code !== 0 ? `exit ${code}` : 'empty reply');
        const tail = stripAnsi(cur.err).trim().split('\n').slice(-5).join('\n');
        if (!retry && !cur.spawnError && !cur.timedOut) {
          console.warn(`  ↻ ${s.id} ${st.me.id}: ${why}, retrying`);
          s.retryTimer = setTimeout(() => next(s, { why, note: failureNote(cur.err) }), RETRY_DELAY);
          return;
        }
        // Refused a tool twice: as in /talk, a note stands in for the turn or the
        // journal entry and the story goes on, unless the last meeting turn was skipped too.
        const tool = refusedTool(cur.err);
        const prev = st.day.turns.filter(m => m.agent).pop();
        if (!tool || (st.kind === 'meeting' && prev?.skipped)) return fail(s, `${st.me.label}: ${why}${tail ? `\n${tail}` : ''}`);
        console.warn(`  ⤳ ${s.id} day ${st.day.n} ${st.kind} ${st.me.id}: refused ${tool}, skipped`);
        const seconds = Math.round((Date.now() - cur.started) / 1000);
        if (st.kind === 'meeting') st.day.turns.push({ agent: st.me.id, label: st.me.label, text: skippedText(st.me.label, tool), skipped: true, seconds });
        else st.me.journal[st.day.n - 1] = skippedText(st.me.label, tool).replace('No reply', 'No journal entry');
        save(s);
        return next(s);
      }
      const seconds = Math.round((Date.now() - cur.started) / 1000);
      if (st.kind === 'meeting') st.day.turns.push({ agent: st.me.id, label: st.me.label, text, seconds });
      else {
        const { journal: entry, svg } = splitDrawing(text);
        const { journal, notes } = splitNotes(entry);
        st.me.journal[st.day.n - 1] = journal.length > MAX_REPLY ? journal.slice(0, MAX_REPLY) + cutAt(MAX_REPLY) : journal;
        if (notes !== undefined) st.me.notes[st.day.n - 1] = notes;
        if (svg) {
          // In the story folder, not at home, where the agent could change it later.
          const file = `drawings/${st.file}.svg`;
          fs.mkdirSync(path.join(s.dir, 'drawings'), { recursive: true });
          fs.writeFileSync(path.join(s.dir, file), svg);
          st.me.drawings[st.day.n - 1] = { file, svg };
        }
      }
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
    const turnsPerDay = clamp(body.turns, 1, MAX_TURNS, 8);
    // How many days the agents are told the story has, when it runs a day at a time.
    const of = body.of === undefined ? undefined : clamp(body.of, 1, MAX_TOTAL, totalDays);
    const evening = typeof body.evening === 'string' && body.evening.trim() ? body.evening.trim() : undefined;
    let files;
    try { files = parseFiles(body.files); } catch (e) { return [400, { error: e.message }]; }

    const id = stamp() + '-' + crypto.randomBytes(2).toString('hex');
    const storyDir = path.join(dir, id);
    const labels = agents.map((a, i) => (typeof body.labels?.[i] === 'string' && body.labels[i].trim()) || a.label || a.id);
    if (labels[0] === labels[1]) { labels[0] += ' (1)'; labels[1] += ' (2)'; }
    const s = {
      id, dir: storyDir, tag: newTag(), meeting: path.join(storyDir, 'meeting'), opener, totalDays, of, turnsPerDay, evening, drawing: body.drawing !== false,
      days: [], queued: [], status: 'running',
      agents: agents.map((a, i) => {
        const aid = a.id + (ids[0] === ids[1] ? `#${i + 1}` : '');
        const slug = aid.replace(/[^\w-]/g, '_');
        return { id: aid, slug, label: labels[i], model: a.model, headless: a.headless, env: a.env, home: path.join(storyDir, 'homes', slug), journal: [], notes: [], drawings: [] };
      }),
    };
    for (const p of [s.meeting, ...s.agents.map(a => a.home)]) fs.mkdirSync(p, { recursive: true });
    s.files = saveFiles(s.meeting, files);
    stories.set(id, s);
    fs.writeFileSync(path.join(storyDir, 'meta.json'),
      JSON.stringify({ id, agents: ids, models: s.agents.map(a => a.model || null), days: totalDays, turnsPerDay, at: new Date().toISOString() }, null, 2));
    save(s);
    console.log(`  ☾ ${id} ${ids.join(' & ')} (${totalDays} days × ${turnsPerDay} turns) in ${storyDir}`);
    next(s);
    return [200, view(s)];
  }

  // Pick up a story saved by another process, with `days` more days (1 by
  // default) and, if given, a new opener: season.js changes it every morning.
  // Commands and models come from agents.json as it is now.
  function restore(storyDir, body = {}) {
    const st = JSON.parse(fs.readFileSync(path.join(storyDir, 'state.json'), 'utf8'));
    if (stories.has(st.id)) return [409, { error: 'Already loaded.' }];
    const cfg = loadConfig();
    const agents = st.agents.map(a => {
      const c = cfg.agents.find(x => x.id === a.id.replace(/#\d+$/, '') && x.type !== 'url' && x.headless);
      if (!c) throw new Error(`${a.id} is not in agents.json any more.`);
      return { ...a, model: c.model, headless: c.headless, env: c.env, home: path.join(storyDir, 'homes', a.slug) };
    });
    const s = { ...st, dir: storyDir, meeting: path.join(storyDir, 'meeting'), agents, error: undefined };
    if (typeof body.opener === 'string' && body.opener.trim()) s.opener = body.opener.trim();
    if (s.status === 'done') s.totalDays = Math.min(MAX_TOTAL, s.days.length + clamp(body.days, 1, MAX_DAYS, 1));
    for (const p of [s.meeting, ...agents.map(a => a.home)]) fs.mkdirSync(p, { recursive: true });
    stories.set(s.id, s);
    s.status = 'running';
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
    let files;
    try { files = parseFiles(body.files, attachedBytes([s, ...s.days.flatMap(d => d.turns), ...s.queued])); } catch (e) { return [400, { error: e.message }]; }
    if (!text && !files.length) return [400, { error: 'Empty message.' }];
    const m = { user: true, label: USER, text, files: saveFiles(s.meeting, files) };
    const d = today(s);
    if (!s.current && d && spokenToday(d) < s.turnsPerDay) { d.turns.push(m); save(s); }
    else s.queued.push(m);
    return [200, view(s)];
  }

  const homeFiles = home => {
    try { return fs.readdirSync(home).filter(f => !f.startsWith('.')).sort().slice(0, 30); } catch { return []; }
  };

  const view = s => ({
    id: s.id, dir: s.dir, opener: s.opener, files: s.files, status: s.status, error: s.error,
    totalDays: s.totalDays, turnsPerDay: s.turnsPerDay,
    agents: s.agents.map(a => ({ id: a.id, label: a.label, model: a.model, home: a.home, files: homeFiles(a.home) })),
    days: s.days.map(d => ({
      n: d.n,
      turns: d.turns.map(({ agent, user, label, text, files, seconds, skipped }) => ({ agent, user, label, text, files, seconds, skipped })),
      journals: s.agents.filter(a => a.journal[d.n - 1] !== undefined).map(a => ({
        agent: a.id, label: a.label, text: a.journal[d.n - 1], notes: a.notes[d.n - 1],
        drawing: a.drawings[d.n - 1],
      })),
    })),
    queued: s.queued.map(m => withFiles(m.text, m.files)),
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

  return { start, restore, stop, resume, say, get, list };
}

module.exports = { createStories, meetingPrompt, eveningPrompt, splitDrawing, splitNotes };
