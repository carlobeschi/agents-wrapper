// @ts-check
// The brainstorm: the game jam (jam.js) made general. A person writes a
// problem, picks the agents, how many ideas each brings and how many of the
// best go forward. Then, with no one in the loop:
//
//   ideas   every agent proposes N ideas, alone, after reading the context
//           folder if there is one.
//   vote    every agent scores the other agents' ideas from 1 to 10, without
//           names and in its own shuffled order; it never sees its own.
//   build   every agent develops the top K ideas, alone, in its own git branch
//           (brainstorm/<agent>) of a copy of the context, and says what it did.
//
// Agents read files to propose and vote, and also edit them to build, only in
// their own folder inside the run folder (commands in brainstorm/agents.json).
// Nothing is pushed or published: the branches stay in the run folder.
//
// Run folder: <out>/<stamp>-<words>/ : state.json (everything the page shows),
// repo/ (the copy of the context), build/<agent>/ (each agent's branch),
// patches/<agent>.patch, steps/ (every prompt and reply).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { loadConfig, agentEnv, fill, noteCall, stamp } = require('../config');
const { killTree, stripAnsi } = require('../talk');
const { refuseLoose, parseIdeas, parseScores, tally, ballot, anonymise } = require('../jam');

const AGENTS_FILE = () => process.env.BRAINSTORM_AGENTS
  || [path.join(os.homedir(), '.agent-dispatch', 'brainstorm-agents.json')].find(f => fs.existsSync(f))
  || path.join(__dirname, 'agents.json');

const PHASES = ['ideas', 'vote', 'build'];
const MAX_REPLY = 200000;

// ---- Agents ----

function onPath(cmd) {
  if (!cmd) return false;
  if (cmd.includes('/')) return fs.existsSync(cmd);
  return (process.env.PATH || '').split(path.delimiter).some(dir => {
    try { fs.accessSync(path.join(dir, cmd), fs.constants.X_OK); return true; } catch { return false; }
  });
}

// The agents of the catalogue, with their model and whether their program is installed.
function loadAgents(file = AGENTS_FILE()) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(raw.agents)) throw new Error(`${file}: "agents" must be a list`);
  const main = (() => { try { return loadConfig(); } catch { return { agents: [] }; } })();
  return raw.agents.map(a => {
    if (!a || typeof a.id !== 'string' || !/^[\w-]{1,40}$/.test(a.id)) throw new Error(`${file}: every agent needs an "id" of letters, digits, - or _`);
    for (const m of ['read', 'build']) {
      if (!Array.isArray(a[m]) || !a[m].length) throw new Error(`${file}: agent ${a.id} has no "${m}" command`);
      refuseLoose(a[m], `agent ${a.id} ${m}`);
    }
    const model = a.model ?? (a.model_from ? main.agents.find(x => x.id === a.model_from)?.model : '') ?? '';
    return { ...a, label: a.label || a.id, model: model || '', env: Array.isArray(a.env) ? a.env : [], available: onPath(a.read[0]) };
  });
}

// The command, with {model} (or the flag before it dropped when there is none) and {price} filled in.
function commandFor(agent, mode) {
  const cmd = agent[mode].slice();
  if (!agent.model) for (let i = cmd.length - 1; i > 0; i--) if (cmd[i] === '{model}') { cmd.splice(i - 1, 2); i--; }
  return fill(cmd.map(s => String(s).split('{price}').join(String(agent.max_price ?? 2))), '{prompt}', agent.model);
}

// ---- One agent call ----

// live: { out, err } updated as the agent writes, for the page. children: to stop them.
function runOnce(agent, mode, prompt, cwd, ms, live, children) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const cmd = commandFor(agent, mode);
    const viaArg = cmd.some(s => s.includes('{prompt}'));
    const [bin, ...args] = cmd.map(s => s.split('{prompt}').join(prompt));
    const cur = { out: '', err: '', timedOut: false, spawnError: '' };
    let child;
    try {
      noteCall(bin);
      // "clean_home": the agent gets an empty home folder of its own, so it loads none of
      // the user's skills, plugins or settings (Vibe reads ~/.agents/skills, for one).
      const env = agentEnv(agent.env);
      if (agent.clean_home) { env.HOME = path.join(os.tmpdir(), `brainstorm-home-${agent.id}`); fs.mkdirSync(env.HOME, { recursive: true, mode: 0o700 }); }
      child = spawn(bin, args, { cwd, env, shell: false, detached: true, stdio: [viaArg ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
      if (!viaArg && child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(prompt); }
    } catch (e) { return resolve({ text: '', why: e.message, err: '', ms: 0 }); }
    children.add(child);
    const timer = setTimeout(() => { cur.timedOut = true; killTree(child); }, ms);
    child.stdout.on('data', c => { if (cur.out.length < MAX_REPLY) cur.out += c; live.out = stripAnsi(cur.out).slice(-6000); });
    child.stderr.on('data', c => { cur.err = (cur.err + c).slice(-64000); live.err = stripAnsi(cur.err).slice(-3000); });
    child.on('error', e => { cur.spawnError = e.message; });
    child.on('close', code => {
      clearTimeout(timer);
      children.delete(child);
      const text = stripAnsi(cur.out).trim();
      const why = cur.spawnError || (cur.timedOut ? 'timed out' : code !== 0 ? `exit ${code}` : !text ? 'empty reply' : null);
      resolve({ text, why, err: cur.err, ms: Date.now() - t0 });
    });
  });
}

// ---- Prompts ----

const contextLine = (S, where) => S.context
  ? `The ${where} holds material for this (${S.context_kind === 'git' ? 'a copy of a git repository' : 'a copy of a folder'}). Read what you need of it.`
  : `The ${where} is empty: there is no material beyond the problem above.`;

function ideasPrompt(S) {
  return [
    `You are one of ${S.agents.length} AI agents, possibly from different AI labs, asked to explore a problem together.`,
    '', 'THE PROBLEM', S.problem, '',
    contextLine(S, 'current folder'),
    '',
    `Propose exactly ${S.ideas_per_agent} distinct idea${S.ideas_per_agent > 1 ? 's' : ''}. Each should address the problem well, and be something one AI agent can develop in one session by working on files in a folder (a prototype, a change to the material, a document, code), with no network.`,
    `Afterwards every agent will score every other agent's ideas, without knowing who proposed them, and the ${S.top} best will be developed by every agent, each on its own.`,
    '',
    'Write each idea exactly like this, and nothing else:',
    'IDEA: a short title',
    'WHAT: two to four sentences: what it is and what it would produce',
    'WHY: one sentence',
  ].join('\n');
}

function votePrompt(S, shown) {
  return [
    'You are one of several AI agents, possibly from different AI labs, exploring a problem together.',
    '', 'THE PROBLEM', S.problem, '',
    contextLine(S, 'current folder'),
    '',
    `Here are ${shown.length} ideas from the other agents (none of them is yours). They are shown without names and in a random order.`,
    '',
    ...shown.map((i, k) => `I${k + 1}. ${anonymise(i.title)}\n    What: ${anonymise(i.what)}\n    Why: ${anonymise(i.why)}`),
    '',
    `Score every idea from 1 (would not develop it) to 10 (must develop it): how well it addresses the problem, how much it adds, and whether one agent can develop it well in one session. The ${S.top} ideas with the best average score will be developed.`,
    'Reply with one line per idea and nothing else, like this:',
    'I1: 7 - a reason in a few words',
  ].join('\n');
}

function buildPrompt(S, winners, canRun) {
  return [
    'You are one of several AI agents, possibly from different AI labs, exploring a problem together.',
    '', 'THE PROBLEM', S.problem, '',
    `In a vote among the agents, these ${winners.length} ideas came top. Develop ${winners.length > 1 ? 'all of them' : 'it'}:`,
    ...winners.map((i, k) => `${k + 1}. ${i.title}\n   What: ${i.what}\n   Why: ${i.why}`),
    '',
    `The current folder is a git branch only for you. ${S.context ? 'It holds the material (a copy): change it where the ideas call for it, or add new files.' : 'It is empty: create the files your work needs.'} Other agents develop the same ideas, each on its own.`,
    'Rules:',
    '- Work only on files in this folder. No network, nothing installed.',
    '- Leave a short BRAINSTORM.md in the folder saying what you made and where it is.',
    canRun ? '- You can run commands in this folder, with no network.' : '- You cannot run commands, so read carefully before you change things.',
    '',
    'When you are done, reply with:',
    'WHAT I BUILT: a few sentences',
    'HOW TO SEE IT: which files to open, for each idea',
    'NOT DONE: anything you left out, or "nothing"',
  ].join('\n');
}

// ---- The context: a copy every agent reads, and builds on in its own branch ----

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const BOT = ['-c', 'user.name=brainstorm', '-c', 'user.email=brainstorm@users.noreply.github.com', '-c', 'commit.gpgsign=false'];
const SKIP = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.DS_Store']);
const MAX_COPY = 300 * 1024 * 1024;

const expandHome = s => s === '~' ? os.homedir() : s.startsWith('~/') ? path.join(os.homedir(), s.slice(2)) : s;
const isUrl = s => /^(https?|ssh|git):\/\//.test(s) || /^git@[\w.-]+:/.test(s);

// What the context field says: nothing, a git URL, or a folder on this machine. Throws if a folder is not there.
function resolveContext(raw) {
  const s = String(raw || '').trim();
  if (!s) return { kind: 'none', src: '' };
  if (isUrl(s)) return { kind: 'git', src: s };
  const p = path.resolve(expandHome(s));
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error(`no folder at ${p}`);
  let top = '';
  try { top = git(p, 'rev-parse', '--show-toplevel'); } catch {}
  return top && path.resolve(top) === fs.realpathSync(p) ? { kind: 'git', src: p } : { kind: 'folder', src: p };
}

function setupRepo(ctx, repo) {
  if (fs.existsSync(path.join(repo, '.git'))) return;
  if (ctx.kind === 'git') {
    execFileSync('git', ['clone', '--quiet', ...(isUrl(ctx.src) ? ['--depth', '1'] : []), ctx.src, repo], { stdio: ['ignore', 'pipe', 'pipe'] });
    return;
  }
  fs.mkdirSync(repo, { recursive: true });
  if (ctx.kind === 'folder') {
    let size = 0;
    fs.cpSync(ctx.src, repo, { recursive: true, dereference: false, filter: f => {
      if (SKIP.has(path.basename(f))) return false;
      const st = fs.lstatSync(f);
      if (st.isSymbolicLink()) return false;
      size += st.isFile() ? st.size : 0;
      if (size > MAX_COPY) throw new Error(`the context folder is over ${MAX_COPY / 1048576} MB; point at a smaller one`);
      return true;
    } });
  }
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  git(repo, ...BOT, 'commit', '-q', '--allow-empty', '-m', 'brainstorm: the context as given');
}

// ---- A run ----

const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().split(/[\s_-]+/).slice(0, 5).join('-').slice(0, 40) || 'run';

class Run {
  /**
   * @param {{ problem: string, context?: string, agents: any[], ideas_per_agent: number, top: number, build_minutes?: number, read_minutes?: number, out: string, seed?: string }} o
   */
  constructor(o) {
    const ctx = resolveContext(o.context);
    const id = `${stamp()}-${slug(o.problem)}`;
    this.dir = path.join(o.out, id);
    this.children = new Set();
    this.stopped = false;
    this.S = {
      id, problem: String(o.problem).trim(), context: ctx.src, context_kind: ctx.kind,
      agents: o.agents.map(a => ({ id: a.id, label: a.label, model: a.model || null })),
      ideas_per_agent: o.ideas_per_agent, top: o.top,
      build_minutes: o.build_minutes ?? 30, read_minutes: o.read_minutes ?? 15,
      phase: 'setup', error: null, steps: {}, ideas: null, ballots: {}, votes: {}, ranking: null, winners: null, tie_at_cut: false, builds: null,
      dir: this.dir, started: new Date().toISOString(), finished: null,
    };
    this.agents = o.agents;
    this.seed = o.seed ?? id;
    fs.mkdirSync(this.dir, { recursive: true });
    this.save();
  }

  save() { try { fs.writeFileSync(path.join(this.dir, 'state.json'), JSON.stringify(this.S, null, 2)); } catch {} }

  stop() {
    this.stopped = true;
    for (const c of this.children) killTree(c);
  }

  // One step, kept in steps/<name>. Reads and votes are tried once more if they fail.
  async step(name, agent, mode, prompt, cwd, ms) {
    const base = path.join(this.dir, 'steps', name);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    fs.writeFileSync(base + '.prompt.md', prompt);
    const st = this.S.steps[name] = { agent: agent.id, mode, status: 'running', started: Date.now(), ms: null, why: null, reply: '', live: { out: '', err: '' } };
    let r = await runOnce(agent, mode, prompt, cwd, ms, st.live, this.children);
    // A build is tried again only if it failed (not ran out of time) before changing anything.
    const untouched = () => { try { return !git(cwd, 'status', '--porcelain'); } catch { return false; } };
    if (r.why && r.why !== 'timed out' && !this.stopped && (mode !== 'build' || untouched())) {
      st.live = { out: '', err: '' };
      r = await runOnce(agent, mode, prompt, cwd, ms, st.live, this.children);
    }
    if (r.err) fs.writeFileSync(base + '.stderr.txt', r.err);
    st.ms = r.ms;
    st.why = this.stopped ? 'stopped' : r.why;
    // A build that ran out of time may still have done good work: it is kept.
    const ok = !st.why || (mode === 'build' && st.why === 'timed out');
    st.status = ok ? 'done' : 'failed';
    st.reply = r.text;
    st.live = { out: '', err: stripAnsi(r.err || '').slice(-1500) };
    fs.writeFileSync(base + (ok ? '.reply.md' : '.failed-reply.md'), r.text || `(no reply: ${st.why})`);
    this.save();
    return ok ? r.text : null;
  }

  async run() {
    try {
      await this.go();
      this.S.phase = this.stopped ? 'stopped' : 'done';
    } catch (e) {
      this.S.phase = this.stopped ? 'stopped' : 'failed';
      this.S.error = String(e && e.message || e).split('\n')[0];
    }
    this.S.finished = new Date().toISOString();
    this.save();
  }

  async go() {
    const S = this.S, A = this.agents, readMs = S.read_minutes * 60000;
    const repo = path.join(this.dir, 'repo');
    setupRepo({ kind: S.context_kind, src: S.context }, repo);

    // 1. Ideas
    S.phase = 'ideas'; this.save();
    const replies = await Promise.all(A.map(a => this.step(`ideas/${a.id}`, a, 'read', ideasPrompt(S), repo, readMs)));
    if (this.stopped) return;
    const ideas = [];
    A.forEach((a, k) => parseIdeas(replies[k] || '').slice(0, S.ideas_per_agent)
      .forEach((i, j) => ideas.push({ key: ideas.length, id: `${a.id}-${j + 1}`, agent: a.id, lab: a.id, ...i })));
    S.ideas = ideas;
    this.save();
    if (ideas.length < S.top) throw new Error(`only ${ideas.length} idea(s) came back, fewer than the ${S.top} to carry forward`);
    if (new Set(ideas.map(i => i.agent)).size < 2) throw new Error('ideas came from one agent only, so nobody else can vote on them');

    // 2. Vote
    S.phase = 'vote'; this.save();
    await Promise.all(A.map(async a => {
      const shown = ballot(ideas, a.id, this.seed);
      if (!shown.length) return;
      S.ballots[a.id] = shown.map(i => i.id);
      const text = await this.step(`vote/${a.id}`, a, 'read', votePrompt(S, shown), repo, readMs);
      const got = parseScores(text || '', 'I', shown.length);
      S.votes[a.id] = Object.fromEntries(Object.entries(got).map(([n, s]) => [shown[Number(n) - 1].key, s]));
    }));
    if (this.stopped) return;
    // Ties are broken in a shuffled order, so the first agent listed has no edge.
    const ranked = tally(ballot(ideas, '', `${this.seed}:ties`), S.votes);
    S.ranking = ranked.map(r => ({ id: r.id, agent: r.agent, title: r.title, mean: r.mean, n: r.n, by: r.by }));
    if (!ranked.some(r => r.n)) throw new Error('no vote could be read');
    S.winners = ranked.slice(0, S.top).map(r => r.id);
    S.tie_at_cut = ranked.length > S.top && ranked[S.top - 1].mean === ranked[S.top].mean && ranked[S.top - 1].n === ranked[S.top].n;
    this.save();

    // 3. Build
    S.phase = 'build'; S.builds = {}; this.save();
    const winners = S.winners.map(id => ideas.find(i => i.id === id));
    const base = git(repo, 'rev-parse', 'HEAD');
    fs.mkdirSync(path.join(this.dir, 'patches'), { recursive: true });
    await Promise.all(A.map(async a => {
      const wt = path.join(this.dir, 'build', a.id);
      if (!fs.existsSync(wt)) git(repo, 'worktree', 'add', '-q', '-b', `brainstorm/${a.id}`, wt, base);
      const text = await this.step(`build/${a.id}`, a, 'build', buildPrompt(S, winners, !!a.can_run), wt, S.build_minutes * 60000);
      git(wt, 'add', '-A');
      if (git(wt, 'status', '--porcelain')) git(wt, ...BOT, 'commit', '-q', '-m', `brainstorm: ${a.label} develops ${winners.map(i => i.title).join(' + ')}`);
      const stat = git(wt, 'diff', '--numstat', base, 'HEAD').split('\n').filter(Boolean).map(s => s.split('\t'));
      const files = stat.map(r => ({ path: r[2], added: Number(r[0]) || 0, removed: Number(r[1]) || 0 }));
      fs.writeFileSync(path.join(this.dir, 'patches', `${a.id}.patch`), files.length ? git(wt, 'format-patch', '--stdout', `${base}..HEAD`) : '');
      S.builds[a.id] = { ok: text != null, report: text || '', files, folder: wt, branch: `brainstorm/${a.id}` };
      this.save();
    }));
  }
}

// Runs already in the output folder (after a restart): read-only, and marked stopped if they never finished.
function pastRuns(out) {
  if (!fs.existsSync(out)) return [];
  return fs.readdirSync(out).map(d => {
    try {
      const S = JSON.parse(fs.readFileSync(path.join(out, d, 'state.json'), 'utf8'));
      if (!['done', 'failed', 'stopped'].includes(S.phase)) S.phase = 'stopped';
      for (const st of Object.values(S.steps || {})) if (st.status === 'running') st.status = 'failed';
      return S;
    } catch { return null; }
  }).filter(Boolean);
}

// A tiny read and a tiny write per agent, in a scratch folder, to see that its commands work.
async function checkAgents(agents) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'brainstorm-check-'));
  const children = new Set();
  try {
    return await Promise.all(agents.map(async a => {
      const d = path.join(scratch, a.id);
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'word.txt'), 'pineapple\n');
      const cheap = { ...a, max_price: 0.2 };
      const r = await runOnce(cheap, 'read', 'Read the file word.txt in the current folder and reply with the word in it, nothing else.', d, 5 * 60000, { out: '', err: '' }, children);
      const w = await runOnce(cheap, 'build', 'Create a file named hello.txt in the current folder containing exactly the word hi. Do nothing else.', d, 5 * 60000, { out: '', err: '' }, children);
      const read = /pineapple/i.test(r.text || '');
      const wrote = fs.existsSync(path.join(d, 'hello.txt')) && /hi/i.test(fs.readFileSync(path.join(d, 'hello.txt'), 'utf8'));
      const why = !read ? `read: ${r.why || 'wrong reply'}` : !wrote ? `write: ${w.why || 'no file'}` : null;
      const tail = why ? stripAnsi((r.err || w.err || r.text || w.text || '').trim()).split('\n').slice(-3).join('\n') : '';
      return { id: a.id, read, wrote, why, tail };
    }));
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

module.exports = { PHASES, AGENTS_FILE, loadAgents, commandFor, resolveContext, ideasPrompt, votePrompt, buildPrompt, Run, pastRuns, checkAgents, slug };
