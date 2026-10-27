// Agent dispatch — one prompt box in front of the coding agents on this laptop.
// Usage: npm start     then open http://localhost:8787
//
// Each selected agent gets the same prompt. In "terminal" mode each one opens in
// its own terminal window, interactive, so the result is inspected in the tool
// itself. In "background" mode each runs headless and its output goes to a log.
// Either way it is the CLI's own signed-in session doing the work — no API keys.
//
// The home page is talk.html: two agents in conversation, one headless call per
// turn (talk.js). /story runs the same pair over several days, with a private
// evening at home between meetings (story.js). The dispatch page is at
// /dispatch, kept as legacy.
//
// The agents run WITH their tools, in a directory the user picks. That is the point of the thing, so the bounds are on who can
// trigger a dispatch, not on what the agent can do once started:
//   127.0.0.1 only          not reachable from the network
//   Host header checked     a DNS-rebound page cannot talk to this port
//   per-process token       served inside the page only; every POST must carry
//                           it as X-Dispatch-Token, so another site cannot
//                           forge a dispatch (it cannot read the page)
//   Origin checked          a POST from another site is refused even with a token
//   no framing              another site cannot load the page in a frame
//   ~/.agent-dispatch 0700  prompts, logs and transcripts are not readable by
//                           other users of the machine
//   attachments            copied into <conversation>/files/ under names the
//                           server picks, from a list of types, size-capped,
//                           never overwriting; agents read them with the
//                           permissions they already have
//   argv arrays, no shell   the prompt never reaches a command line; terminal
//                           mode reads it from a file inside the script
//   trimmed environment     headless agents get PATH, HOME, locale and proxy
//                           settings, plus the names their "env" lists

const http    = require('http');
const crypto  = require('crypto');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const { spawn, execFileSync } = require('child_process');
const { createTalks } = require('./talk');
const { createStories } = require('./story');
const attach = require('./attach');

const PORT      = Number(process.env.AGENT_DISPATCH_PORT) || 8787;
const HOME_DIR  = process.env.AGENT_DISPATCH_HOME || path.join(os.homedir(), '.agent-dispatch');
const RUNS_DIR  = path.join(HOME_DIR, 'runs');
const TALKS_DIR = path.join(HOME_DIR, 'talks');
const STORIES_DIR = path.join(HOME_DIR, 'stories');
const SAVED_DIR = path.join(HOME_DIR, 'conversations');
const CONFIG    = process.env.AGENT_DISPATCH_CONFIG
  || (fs.existsSync(path.join(HOME_DIR, 'agents.json')) ? path.join(HOME_DIR, 'agents.json')
                                                         : path.join(__dirname, 'agents.json'));
const PAGES     = { '/': 'talk.html', '/talk': 'talk.html', '/story': 'story.html', '/dispatch': 'dispatch.html' };
const TOKEN     = crypto.randomBytes(24).toString('hex');
const MAX_BODY  = 256 * 1024;

// Background runs, by run id then agent id. In memory only; the logs are on disk.
const runs = new Map();

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  if (!Array.isArray(cfg.agents)) throw new Error(`${CONFIG}: "agents" must be an array`);
  return cfg;
}

// Resolve a bare command name against PATH, without spawning `which`.
function onPath(cmd) {
  if (!cmd) return false;
  if (cmd.includes('/')) return fs.existsSync(cmd);
  return (process.env.PATH || '').split(path.delimiter).some(dir => {
    try { fs.accessSync(path.join(dir, cmd), fs.constants.X_OK); return true; } catch { return false; }
  });
}

function describeAgents(cfg) {
  return cfg.agents.map(a => ({
    id: a.id,
    label: a.label || a.id,
    type: a.type || 'cli',
    url: a.type === 'url' ? a.url : undefined,
    available: a.type === 'url' ? true : onPath((a.interactive || a.headless || [])[0]),
    modes: a.type === 'url' ? ['browser']
         : ['terminal', 'background'].filter(m => (m === 'terminal' ? a.interactive : a.headless)),
  }));
}

const fill = (args, prompt) => args.map(s => s.split('{prompt}').join(prompt));

// What an agent is given of this process's environment: enough to run and reach
// the network, plus the names its "env" in agents.json lists (an API key, say).
// Not the rest: tokens and keys in the shell that ran `npm start` stay out of
// reach of an agent that can be talked into printing them.
const BASE_ENV = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
];
const agentEnv = names => Object.fromEntries([...BASE_ENV, ...(Array.isArray(names) ? names : [])]
  .filter(k => typeof k === 'string' && process.env[k] !== undefined).map(k => [k, process.env[k]]));

// POSIX single-quote, for the one place a value has to sit inside a shell script.
const sq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The default terminal launcher for this OS. `{script}` is replaced with the path
// of an executable shell script. Overridable with "terminal" in agents.json.
function defaultTerminal() {
  if (process.platform === 'darwin') return ['open', '-a', 'Terminal', '{script}'];
  for (const t of [['x-terminal-emulator', '-e'], ['gnome-terminal', '--'], ['konsole', '-e'], ['xterm', '-e']]) {
    if (onPath(t[0])) return [...t, 'bash', '{script}'];
  }
  return null;
}

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// One git worktree per agent, so four agents editing one repo do not collide.
function makeWorktree(cwd, runDir, runId, agentId) {
  const top = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const dir = path.join(runDir, 'worktrees', agentId);
  const branch = `dispatch/${runId}-${agentId}`;
  execFileSync('git', ['-C', top, 'worktree', 'add', '-q', '-b', branch, dir], { stdio: 'pipe' });
  // Keep the same sub-directory the user pointed at, if it was below the repo root.
  return { dir: path.join(dir, path.relative(top, cwd)), branch };
}

function launchTerminal(cfg, agent, prompt, promptFile, cwd, runDir) {
  const launcher = cfg.terminal || defaultTerminal();
  if (!launcher) throw new Error('No terminal found. Set "terminal" in agents.json, or use background mode.');
  // The prompt is read from a file at run time, so it is never quoted into the script.
  const args = agent.interactive.map(s => s === '{prompt}' ? '"$PROMPT"' : sq(s.split('{prompt}').join(prompt)));
  const script = path.join(runDir, `${agent.id}.command`);
  fs.writeFileSync(script, [
    '#!/bin/bash',
    `export PATH=${sq(process.env.PATH || '')}`,
    `cd ${sq(cwd)} || exit 1`,
    `PROMPT="$(cat ${sq(promptFile)})"`,
    `printf '\\033]0;%s\\007' ${sq(agent.label || agent.id)}`,
    args.join(' '),
    // Stay in the directory once the agent exits, so the result can be looked at.
    'exec "${SHELL:-/bin/bash}" -l',
    '',
  ].join('\n'), { mode: 0o700 });
  const [cmd, ...rest] = launcher.map(s => s === '{script}' ? script : s);
  const child = spawn(cmd, rest, { detached: true, stdio: 'ignore', shell: false });
  child.on('error', e => console.warn(`  ✗ ${agent.id}: terminal launch failed: ${e.message}`));
  child.unref();
  return { script };
}

function launchBackground(agent, prompt, cwd, runDir, runId) {
  const log = path.join(runDir, `${agent.id}.log`);
  const out = fs.openSync(log, 'a');
  const [cmd, ...args] = fill(agent.headless, prompt);
  const child = spawn(cmd, args, { cwd, env: agentEnv(agent.env), shell: false, stdio: ['ignore', out, out] });
  const entry = { status: 'running', started: Date.now(), log, pid: child.pid };
  runs.get(runId).agents[agent.id] = entry;
  child.on('error', e => { fs.appendFileSync(log, `\n[dispatch] ${e.message}\n`); entry.status = 'failed'; });
  child.on('close', code => {
    fs.closeSync(out);
    entry.status = code === 0 ? 'done' : 'failed';
    entry.code = code;
    entry.finished = Date.now();
    console.log(`  ${code === 0 ? '✓' : '✗'} ${runId} ${agent.id}: exit ${code}`);
  });
  return { log };
}

function dispatch(body) {
  const cfg = loadConfig();
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt.trim()) return [400, { error: 'Empty prompt.' }];
  const ids = Array.isArray(body.agents) ? body.agents : [];
  const agents = ids.map(id => cfg.agents.find(a => a.id === id && a.type !== 'url'));
  if (!agents.length || agents.some(a => !a)) return [400, { error: 'Unknown or missing agent.' }];
  const mode = body.mode === 'background' ? 'background' : 'terminal';
  const cwd = path.resolve((body.cwd || '').replace(/^~(?=$|\/)/, os.homedir()) || os.homedir());
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return [400, { error: `Not a directory: ${cwd}` }];

  const runId = stamp() + '-' + crypto.randomBytes(2).toString('hex');
  const runDir = path.join(RUNS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const promptFile = path.join(runDir, 'prompt.md');
  fs.writeFileSync(promptFile, prompt);
  fs.writeFileSync(path.join(runDir, 'meta.json'),
    JSON.stringify({ runId, cwd, mode, isolate: !!body.isolate, agents: ids, at: new Date().toISOString() }, null, 2));
  runs.set(runId, { runId, cwd, mode, prompt: prompt.slice(0, 200), agents: {} });

  const results = agents.map(agent => {
    try {
      const args = mode === 'terminal' ? agent.interactive : agent.headless;
      if (!args) throw new Error(`${agent.label || agent.id} has no ${mode} command.`);
      let dir = cwd, branch;
      if (body.isolate) ({ dir, branch } = makeWorktree(cwd, runDir, runId, agent.id));
      const r = mode === 'terminal'
        ? launchTerminal(cfg, agent, prompt, promptFile, dir, runDir)
        : launchBackground(agent, prompt, dir, runDir, runId);
      if (mode === 'terminal') runs.get(runId).agents[agent.id] = { status: 'opened', started: Date.now() };
      console.log(`  → ${runId} ${agent.id} (${mode}) in ${dir}`);
      return { agent: agent.id, ok: true, cwd: dir, branch, ...r };
    } catch (e) {
      const msg = (e.stderr && e.stderr.toString().trim()) || e.message;
      runs.get(runId).agents[agent.id] = { status: 'failed', error: msg };
      console.warn(`  ✗ ${runId} ${agent.id}: ${msg}`);
      return { agent: agent.id, ok: false, error: msg };
    }
  });
  return [200, { runId, runDir, results }];
}

function listRuns() {
  return [...runs.values()].reverse().slice(0, 20).map(r => ({
    runId: r.runId, cwd: r.cwd, mode: r.mode, prompt: r.prompt,
    agents: Object.fromEntries(Object.entries(r.agents).map(([id, a]) => [id, {
      status: a.status, code: a.code, error: a.error, hasLog: !!a.log,
      seconds: Math.round(((a.finished || Date.now()) - a.started) / 1000),
    }])),
  }));
}

function readLog(runId, agentId) {
  const a = runs.get(runId)?.agents[agentId];
  if (!a?.log) return null;
  const buf = fs.readFileSync(a.log);
  return buf.length > 512 * 1024 ? buf.subarray(buf.length - 512 * 1024).toString('utf8') : buf.toString('utf8');
}

function send(res, status, type, body) {
  res.writeHead(status, {
    'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'",
  });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, 'application/json', JSON.stringify(obj));

const talks = createTalks({ loadConfig, fill, agentEnv, stamp, dir: TALKS_DIR, savedDir: SAVED_DIR });
const stories = createStories({ loadConfig, fill, agentEnv, stamp, dir: STORIES_DIR });

// Read a JSON body, then answer with handler(body) -> [status, object].
// `max` is larger for the routes that take attachments.
function withBody(req, res, handler, max = MAX_BODY) {
  const chunks = []; let size = 0;
  req.on('data', c => {
    size += c.length;
    if (size > max) { json(res, 413, { error: max > MAX_BODY ? 'Attachments too large.' : 'Prompt too large.' }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (res.headersSent) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(res, 400, { error: 'Bad JSON.' }); }
    try { const [status, out] = handler(body); json(res, status, out); }
    catch (e) { json(res, 500, { error: e.message }); }
  });
}

const server = http.createServer((req, res) => {
  // DNS rebinding: a hostile name resolving to 127.0.0.1 still sends its own Host.
  if (!new RegExp(`^(localhost|127\\.0\\.0\\.1):${PORT}$`).test(req.headers.host || '')) {
    return send(res, 403, 'text/plain', 'Forbidden host');
  }
  // Browsers send Origin on every cross-site request and on same-origin POSTs.
  const origin = req.headers.origin;
  if (origin && !new RegExp(`^http://(localhost|127\\.0\\.0\\.1):${PORT}$`).test(origin)) {
    return send(res, 403, 'text/plain', 'Forbidden origin');
  }
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && PAGES[url.pathname]) {
    const html = fs.readFileSync(path.join(__dirname, PAGES[url.pathname]), 'utf8').replace('__DISPATCH_TOKEN__', TOKEN);
    return send(res, 200, 'text/html; charset=utf-8', html);
  }

  // Everything under /api needs the token — reads included, since logs carry the prompts.
  if (!url.pathname.startsWith('/api/')) return send(res, 404, 'text/plain', 'Not found');
  if (req.headers['x-dispatch-token'] !== TOKEN) return json(res, 403, { error: 'Bad token. Reload the page.' });

  try {
    if (req.method === 'GET' && url.pathname === '/api/agents') {
      const cfg = loadConfig();
      return json(res, 200, { agents: describeAgents(cfg), defaultCwd: cfg.defaultCwd || '', config: CONFIG, runsDir: RUNS_DIR });
    }
    if (req.method === 'GET' && url.pathname === '/api/runs') return json(res, 200, { runs: listRuns() });
    if (req.method === 'GET' && url.pathname === '/api/log') {
      const text = readLog(url.searchParams.get('run'), url.searchParams.get('agent'));
      return text === null ? json(res, 404, { error: 'No log.' }) : send(res, 200, 'text/plain; charset=utf-8', text);
    }
    if (req.method === 'POST' && url.pathname === '/api/dispatch') return withBody(req, res, dispatch);

    if (req.method === 'GET' && url.pathname === '/api/talks') return json(res, 200, { talks: talks.list() });
    if (req.method === 'GET' && url.pathname === '/api/talk') return json(res, ...talks.get(url.searchParams.get('id')));
    if (req.method === 'POST' && url.pathname === '/api/talk') return withBody(req, res, talks.start, attach.MAX_BODY);
    if (req.method === 'POST' && url.pathname === '/api/talks/clear') return json(res, ...talks.clear());
    const m = url.pathname.match(/^\/api\/talk\/(stop|resume|say)$/);
    if (req.method === 'POST' && m) return withBody(req, res, body => talks[m[1]](body.id, body), m[1] === 'say' ? attach.MAX_BODY : MAX_BODY);

    if (req.method === 'GET' && url.pathname === '/api/stories') return json(res, 200, { stories: stories.list() });
    if (req.method === 'GET' && url.pathname === '/api/story') return json(res, ...stories.get(url.searchParams.get('id')));
    if (req.method === 'POST' && url.pathname === '/api/story') return withBody(req, res, stories.start, attach.MAX_BODY);
    const sm = url.pathname.match(/^\/api\/story\/(stop|resume|say)$/);
    if (req.method === 'POST' && sm) return withBody(req, res, body => stories[sm[1]](body.id, body), sm[1] === 'say' ? attach.MAX_BODY : MAX_BODY);
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

// Private to this user: everything below it holds prompts and agent output.
fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
fs.chmodSync(HOME_DIR, 0o700);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent dispatch on http://localhost:${PORT}`);
  console.log(`  config: ${CONFIG}`);
  console.log(`  runs:   ${RUNS_DIR}`);
  console.log(`  talks:  ${TALKS_DIR}`);
  console.log(`  stories: ${STORIES_DIR}`);
});
