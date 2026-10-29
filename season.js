#!/usr/bin/env node
// A season of /story, one day a day, unattended: `node season.js <season.json>`.
//
// Each run plays the next day (the meeting and both evenings) with the same
// story.js and the same headless commands as the page, so the agents get no
// permission they don't have there. Then it writes the day as an episode in the
// show's format (the-second-room's README), with names and home-folder paths
// taken out, and either leaves it in the season's folder (--local) or opens a
// pull request on the show repo. Nothing is published until that PR is merged.
//
// The season file is the director's: the brief, the journal prompt, one morning
// per day. It stays on this machine, so nothing from it shows ahead of time.
// Where the season is up to is in <season.json>'s folder, `s<n>.state.json`.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { createStories } = require('./story');
const { HOME_DIR, loadConfig, fill, agentEnv, stamp } = require('./config');
const { stripAnsi } = require('./talk');

const POLL = 2000;
const EDITOR_TIMEOUT = 5 * 60 * 1000;

const usage = () => {
  console.error('usage: node season.js <season.json> [--local] [--day <n>]');
  process.exit(2);
};

// ---- Taking out what must not leave the laptop ----

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The home folder and user name are always on the list; the season file adds
// the producer's name and anything else. Longest first, so "Ada Lovelace" goes
// before "Ada".
function redactor(extra = []) {
  const pairs = [[os.homedir(), '~'], [os.userInfo().username, '[redacted]'], ...extra]
    .filter(([find]) => find && find.length > 1)
    .sort((a, b) => b[0].length - a[0].length);
  const redact = text => pairs.reduce((t, [find, put]) =>
    t.replace(new RegExp(`(?<![\\w])${escapeRe(find)}(?![\\w])`, 'gi'), put), String(text));
  const leaks = text => pairs.map(([find]) => find).filter(find => new RegExp(escapeRe(find), 'i').test(text));
  return { redact, leaks };
}

// The site renders every text with kramdown, which would pass HTML, links and
// its own {: } syntax straight to the page. Agent text is escaped so that none
// of that runs: no tags, no links, no images, no attribute lists. Code blocks
// are left alone; kramdown shows them as text.
function inertForSite(text) {
  let fenced = false;
  return String(text).split('\n').map(l => {
    if (/^\s*(```|~~~)/.test(l)) { fenced = !fenced; return l; }
    return fenced ? l : l.replace(/([<\[{])/g, '\\$1');
  }).join('\n');
}

// The title and the teaser are put on the page as they are, not as Markdown.
const plain = text => String(text).replace(/[<>]/g, '');

// ---- YAML front matter ----

// Strings as JSON (valid YAML) when short, as a block scalar when they have lines.
function yamlString(s, indent) {
  s = String(s).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '');
  if (!s.includes('\n') || /^\s/.test(s)) return JSON.stringify(s);
  const pad = ' '.repeat(indent);
  return '|\n' + s.split('\n').map(l => (l ? pad + l : '')).join('\n');
}

function yaml(v, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    return v.map(item => {
      const body = yaml(item, indent + 2).replace(/^\s+/, '');
      return `${pad}- ${body}`;
    }).join('\n');
  }
  return Object.entries(v).filter(([, x]) => x !== undefined && x !== null).map(([k, x]) => {
    if (typeof x === 'object') return `${pad}${k}:\n${yaml(x, indent + 2)}`;
    if (typeof x === 'number' || typeof x === 'boolean') return `${pad}${k}: ${x}`;
    return `${pad}${k}: ${yamlString(x, indent + 2)}`;
  }).join('\n');
}

// ---- The editor: a title and a two-line teaser, quoted, not written ----

function runAgent(agent, prompt, cwd) {
  return new Promise(resolve => {
    const [cmd, ...args] = fill(agent.headless, prompt, agent.model);
    let out = '', err = '';
    const child = spawn(cmd, args, { cwd, env: agentEnv(agent.env), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGTERM'), EDITOR_TIMEOUT);
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, out: stripAnsi(out), err }); });
  });
}

const squash = s => s.replace(/\s+/g, ' ').trim();

async function editorPick(agent, dir, ep, names) {
  const said = ep.meeting.filter(t => t.by !== 'note').map(t => `[meeting, ${t.by}] ${t.text}`).join('\n\n');
  const wrote = Object.entries(ep.journals).map(([k, j]) => `[journal, ${k}] ${j}`).join('\n\n');
  const prompt = [
    `You are the editor of a serialized show in which ${names.join(' and ')} meet each day, then each writes a private journal. Below is today's episode.`,
    'Pick a title and a two-line teaser. Quote, don\'t write: the teaser is one sentence said in the meeting and one sentence written in a journal, by different speakers if you can, copied exactly. The title is two to six words, from the episode.',
    'Reply with JSON only, no fence, in this shape:',
    '{"title": "...", "thread": [{"from": "meeting", "by": "<key>", "text": "..."}, {"from": "journal", "by": "<key>", "text": "..."}]}',
    `Keys: ${Object.keys(ep.journals).join(', ')}.`,
    '', '## Episode', '', said, '', wrote,
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'editor.prompt.md'), prompt);
  const r = await runAgent(agent, prompt, dir);
  fs.writeFileSync(path.join(dir, 'editor.reply.txt'), r.out + (r.err ? `\n\n--- stderr ---\n${r.err}` : ''));
  try {
    const pick = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1));
    const title = squash(String(pick.title || '')).slice(0, 80);
    // A teaser line that isn't really in the episode is dropped, not trusted.
    const source = { meeting: squash(said), journal: squash(wrote) };
    const thread = (Array.isArray(pick.thread) ? pick.thread : []).filter(t =>
      ['meeting', 'journal'].includes(t?.from) && ep.journals[t.by] !== undefined && typeof t.text === 'string'
      && t.text.trim() && source[t.from].includes(squash(t.text)))
      .map(t => ({ from: t.from, by: t.by, text: squash(t.text) }));
    return { title: title || undefined, thread: thread.length === 2 ? thread : undefined };
  } catch { return {}; }
}

// ---- The episode ----

function episode(season, st, n, models) {
  const d = st.days[n - 1];
  const meeting = d.turns.map(t =>
    t.user ? { by: 'note', text: `The producer said: ${t.text}` }
    : t.skipped ? { by: 'note', text: t.text.replace(/^\(|\)$/g, '') }
    : { by: t.agent.replace(/#\d+$/, ''), text: t.text });
  const journals = {};
  for (const a of st.agents) if (a.journal[n - 1] !== undefined) journals[a.id.replace(/#\d+$/, '')] = a.journal[n - 1];
  return { season: season.season, day: n, morning: season.mornings[n - 1], meeting, journals, models };
}

// Rough size of the day, per agent: what went in and what came out, from the
// prompts and replies saved under steps/. Tokens are about chars / 4.
function daySize(storyDir, st, n) {
  const pre = `d${String(n).padStart(2, '0')}-`;
  const steps = path.join(storyDir, 'steps');
  const out = {};
  for (const a of st.agents) {
    const files = fs.readdirSync(steps).filter(f => f.startsWith(pre) && /\.prompt\.md$/.test(f) && f.replace(/(\.retry)?\.prompt\.md$/, '').endsWith(`-${a.slug}`));
    const promptChars = files.reduce((sum, f) => sum + fs.statSync(path.join(steps, f)).size, 0);
    const d = st.days[n - 1];
    const replyChars = d.turns.filter(t => t.agent === a.id).reduce((sum, t) => sum + t.text.length, 0)
      + (a.journal[n - 1] || '').length + (a.notes[n - 1] || '').length;
    out[a.id] = { model: a.model, calls: files.length, inputTokens: Math.round(promptChars / 4), outputTokens: Math.round(replyChars / 4) };
  }
  return out;
}

// ---- The show repo ----

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function openPullRequest(season, n, file, text, title) {
  const repo = season.repo.replace(/^~(?=$|\/)/, os.homedir());
  const branch = `episode/s${season.season}-day-${n}`;
  const rel = `_episodes/s${season.season}/day-${n}.md`;
  git(repo, 'fetch', 'origin', 'main');
  git(repo, 'checkout', '-B', branch, 'origin/main');
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
  git(repo, 'add', rel);
  git(repo, 'commit', '-m', `Season ${season.season}, day ${n}: ${title}`);
  git(repo, 'push', '-u', 'origin', branch, '--force-with-lease');
  const body = [`Season ${season.season}, day ${n}: **${title}**.`, '', 'Merge to publish. The episode file is the whole change.', '', `Run folder on the laptop: \`${file}\``].join('\n');
  return execFileSync('gh', ['pr', 'create', '--repo', season.github, '--head', branch, '--base', 'main',
    '--title', `S${season.season} day ${n}: ${title}`, '--body', body], { cwd: repo, encoding: 'utf8' }).trim();
}

// ---- One day ----

async function main() {
  const argv = process.argv.slice(2);
  const file = argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--day');
  if (!file) usage();
  const local = argv.includes('--local');
  const season = JSON.parse(fs.readFileSync(file, 'utf8'));
  const stateFile = path.join(path.dirname(path.resolve(file)), `s${season.season}.state.json`);
  const progress = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  const length = season.length || 7;

  const cfg = loadConfig();
  const stories = createStories({ loadConfig, fill, agentEnv, stamp, dir: path.join(HOME_DIR, 'stories') });

  let st = progress.story ? JSON.parse(fs.readFileSync(path.join(progress.story, 'state.json'), 'utf8')) : null;
  // The day to play: the next one, or the one a failed run left unfinished.
  const n = !st ? 1 : st.status === 'done' ? st.days.length + 1 : st.days.length;
  const wanted = argv.includes('--day') ? Number(argv[argv.indexOf('--day') + 1]) : n;
  if (wanted !== n) throw new Error(`The season is at day ${n}, not ${wanted}.`);
  if (n > length) { console.log(`Season ${season.season} is over (${length} days).`); return; }
  const morning = season.mornings[n - 1];
  if (typeof morning !== 'string' || !morning.trim()) throw new Error(`Day ${n} has no morning in ${file}.`);

  // The brief is the same every day but for the day number and the morning;
  // story.js fills {partner} for each agent.
  const opener = season.brief.split('{n}').join(String(n)).split('{event}').join(morning.trim());
  console.log(`Season ${season.season}, day ${n}: ${morning}`);

  const [status, view] = !st
    ? stories.start({ agents: season.agents, labels: season.names, opener, days: 1, of: length, turns: season.turns || 8,
                      evening: season.evening, drawing: false })
    : stories.restore(progress.story, { opener, days: 1 });
  if (status !== 200) throw new Error(view.error);
  if (!progress.story) fs.writeFileSync(stateFile, JSON.stringify({ story: view.dir }, null, 2));

  // story.js runs the day in the background; wait for it.
  let v;
  do {
    await new Promise(r => setTimeout(r, POLL));
    v = stories.get(view.id)[1];
  } while (v.status === 'running');
  st = JSON.parse(fs.readFileSync(path.join(view.dir, 'state.json'), 'utf8'));
  if (v.status !== 'done') throw new Error(`Day ${n} ${v.status}: ${v.error || ''}`);

  // ---- Export ----
  const models = Object.fromEntries(st.agents.map(a => [a.id.replace(/#\d+$/, ''), a.model || '(CLI default)']));
  const { redact, leaks } = redactor(season.redact);
  const ep = episode(season, st, n, models);
  ep.meeting = ep.meeting.map(t => ({ by: t.by, text: redact(t.text) }));
  for (const k of Object.keys(ep.journals)) ep.journals[k] = redact(ep.journals[k]);

  // The editor reads the redacted day, so what it quotes is already clean.
  const out = path.join(view.dir, 'episodes');
  fs.mkdirSync(out, { recursive: true });
  const editor = cfg.agents.find(a => a.id === (season.editor || 'claude'));
  const pick = editor ? await editorPick(editor, out, ep, season.names) : {};
  const today = new Date(), p = x => String(x).padStart(2, '0');
  const front = {
    season: ep.season, day: n, title: plain(redact(pick.title || `Day ${n}`)),
    date: `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`,
    morning: ep.morning, models: ep.models,
    thread: pick.thread?.map(t => ({ ...t, text: plain(t.text) })),
    meeting: ep.meeting.map(t => ({ by: t.by, text: t.by === 'note' ? plain(t.text) : inertForSite(t.text) })),
    journals: Object.fromEntries(Object.entries(ep.journals).map(([k, j]) => [k, inertForSite(j)])),
  };
  const text = `---\n${yaml(front)}\n---\n`;

  // Last check, on the file as it would go out.
  const left = leaks(text);
  if (left.length) throw new Error(`Not exported: day ${n} still contains ${left.length} redacted term(s). See ${view.dir}.`);
  const epFile = path.join(out, `day-${n}.md`);
  fs.writeFileSync(epFile, text);
  const size = daySize(view.dir, st, n);
  fs.writeFileSync(path.join(out, `day-${n}.size.json`), JSON.stringify(size, null, 2));
  console.log(`Episode: ${epFile}`);
  console.log(`Size: ${JSON.stringify(size)}`);

  if (local || season.pr === false) return;
  const url = openPullRequest(season, n, view.dir, text, title);
  console.log(`Pull request: ${url}`);
}

main().catch(e => { console.error(`season: ${e.message}`); process.exit(1); });
