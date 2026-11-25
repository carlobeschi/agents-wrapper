// @ts-check
// The brainstorm app: `node brainstorm/server.js`, then open the link it prints.
// A page to write a problem, pick agents and numbers, start a brainstorm
// (engine.js) and watch it: ideas as they come, the anonymous vote, the builds.
//
// Same guards as the main app (server.js): 127.0.0.1 only; Host header
// checked; a fresh key at each start, only in the printed link's #fragment,
// required on every /api call; Origin checked on POST; no framing; CSP lets
// only the page's own script run. Agent text is shown as text, never as HTML,
// and files are served as plain text from inside a run folder only.
//
// BRAINSTORM_PORT (8795), BRAINSTORM_OUT (~/.agent-dispatch/brainstorm),
// BRAINSTORM_AGENTS (the agent catalogue; see agents.json here).

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadAgents, Run, pastRuns, checkAgents, AGENTS_FILE, instructionSets, setHuman } = require('./engine');

// Ready-made scenarios (examples/presets.json). "@app" is this app's own folder;
// "@examples/<name>" a small project shipped next to it.
const EXAMPLES = path.join(__dirname, 'examples');
const presets = () => { try { return JSON.parse(fs.readFileSync(path.join(EXAMPLES, 'presets.json'), 'utf8')).presets || []; } catch { return []; } };
function placeholderContext(c) {
  c = String(c || '').trim();
  if (c === '@app') return __dirname;
  const m = /^@examples\/([\w-]+)$/.exec(c);
  if (m) { const d = path.join(EXAMPLES, m[1]); if (!fs.existsSync(d)) throw new Error(`no example "${m[1]}"`); return d; }
  if (c.startsWith('@')) throw new Error(`unknown context ${c}: use @app or @examples/<name>`);
  return c;
}

const PORT = Number(process.env.BRAINSTORM_PORT) || 8795;
const OUT = path.resolve((process.env.BRAINSTORM_OUT || path.join(os.homedir(), '.agent-dispatch', 'brainstorm')).replace(/^~(?=\/|$)/, os.homedir()));
const KEY = crypto.randomBytes(24).toString('hex');
const MAX_BODY = 64 * 1024;
const MAX_FILE = 2 * 1024 * 1024;

fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });

/** @type {Map<string, any>} id -> Run (this session) or a past state */
const runs = new Map();
for (const S of pastRuns(OUT)) runs.set(S.id, { S, past: true });

const stateOf = r => r.S;
const brief = S => ({ id: S.id, problem: S.problem.slice(0, 160), phase: S.phase, started: S.started, agents: S.agents.map(a => a.label) });

const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/page.js': ['page.js', 'text/javascript; charset=utf-8'] };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const readBody = req => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', c => { s += c; if (s.length > MAX_BODY) { reject(new Error('too big')); req.destroy(); } });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('not JSON')); } });
});

const int = (v, lo, hi, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // api, ...
  if (req.method === 'GET' && parts[1] === 'agents') {
    return send(res, 200, { file: AGENTS_FILE(), out: OUT, presets: presets(), instructions: instructionSets().map(x => ({ id: x.id, label: x.label })), agents: loadAgents().map(a => ({ id: a.id, label: a.label, model: a.model || null, available: a.available, web: a.web, can_run: !!a.can_run })) });
  }
  if (parts[1] === 'check' && req.method === 'POST') {
    const body = await readBody(req);
    const pick = loadAgents().filter(a => a.available && (body.agents || []).includes(a.id));
    return send(res, 200, { results: await checkAgents(pick) });
  }
  if (parts[1] !== 'runs') return send(res, 404, { error: 'not found' });
  if (parts.length === 2 && req.method === 'GET') return send(res, 200, [...runs.values()].map(r => brief(stateOf(r))).sort((a, b) => b.started.localeCompare(a.started)));
  if (parts.length === 2 && req.method === 'POST') {
    const b = await readBody(req);
    const problem = String(b.problem || '').trim();
    if (!problem) return send(res, 400, { error: 'Write the problem first.' });
    const all = loadAgents();
    const agents = all.filter(a => (b.agents || []).includes(a.id));
    const missing = agents.filter(a => !a.available).map(a => a.label);
    if (missing.length) return send(res, 400, { error: `Not installed on this machine: ${missing.join(', ')}.` });
    if (agents.length < 2) return send(res, 400, { error: 'Pick at least two agents: each votes only on the others\' ideas.' });
    const ideas = int(b.ideas_per_agent, 1, 10, 3);
    const top = int(b.top, 1, 10, 2);
    if (top > ideas * (agents.length - 1)) return send(res, 400, { error: `Carrying ${top} forward needs more ideas: each agent only sees the others' ideas.` });
    let run;
    try {
      run = new Run({ problem, context: placeholderContext(b.context), agents, max_words: int(b.max_words, 0, 500, 0), blind: !!b.blind, example: String(b.example || '').slice(0, 40) || undefined, ideas_per_agent: ideas, top, build_minutes: int(b.build_minutes, 1, 180, 30), research: String(b.research || 'off'), instructions: String(b.instructions || 'claude'), criteria: String(b.criteria || '').split('\n').map(s => s.replace(/^[\s*•\d.)-]+/, '').trim().slice(0, 200)).filter(Boolean), out: OUT });
    } catch (e) { return send(res, 400, { error: String(e.message || e) }); }
    runs.set(run.S.id, run);
    run.run();
    return send(res, 200, { id: run.S.id });
  }
  const r = runs.get(parts[2]);
  if (!r) return send(res, 404, { error: 'no such run' });
  if (parts.length === 3 && req.method === 'GET') return send(res, 200, stateOf(r));
  if (parts[3] === 'stop' && req.method === 'POST') { if (!r.past) r.stop(); return send(res, 200, { ok: true }); }
  if (parts[3] === 'human' && req.method === 'POST') {
    // The person's blind pick, or their ratings after the builds; saved with the run.
    const err = setHuman(r.S, await readBody(req));
    if (err) return send(res, 400, { error: err });
    if (r.past) fs.writeFileSync(path.join(r.S.dir, 'state.json'), JSON.stringify(r.S, null, 2)); else r.save();
    return send(res, 200, { ok: true, human: r.S.human });
  }
  if (parts[3] === 'file' && req.method === 'GET') {
    // A file inside this run's folder, as plain text.
    const root = fs.realpathSync(r.S.dir);
    let f;
    try { f = fs.realpathSync(path.resolve(root, url.searchParams.get('path') || '')); } catch { return send(res, 404, { error: 'no such file' }); }
    if (!f.startsWith(root + path.sep) || !fs.statSync(f).isFile()) return send(res, 404, { error: 'no such file' });
    const buf = fs.readFileSync(f).subarray(0, MAX_FILE);
    return send(res, 200, buf, 'text/plain; charset=utf-8');
  }
  return send(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || '';
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: 'bad host' });
    const url = new URL(req.url || '/', `http://${host}`);
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return send(res, 200, fs.readFileSync(path.join(__dirname, file)), type);
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    const tok = String(req.headers['x-brainstorm-key'] || '');
    if (tok.length !== KEY.length || !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(KEY))) return send(res, 401, { error: 'Open the link the app printed when it started.' });
    if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== `http://${host}`) return send(res, 403, { error: 'bad origin' });
    await api(req, res, url);
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: String(e && e.message || e) });
  }
});

const shutdown = () => { for (const r of runs.values()) if (!r.past) r.stop(); setTimeout(() => process.exit(0), 300); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Brainstorm on http://127.0.0.1:${PORT}/#k=${KEY}`);
  console.log(`Runs are saved in ${OUT}. Agents from ${AGENTS_FILE()}. Ctrl-C stops the app and any run.`);
  if (process.env.BRAINSTORM_OPEN && process.platform === 'darwin') require('child_process').spawn('open', [`http://127.0.0.1:${PORT}/#k=${KEY}`], { stdio: 'ignore', detached: true }).unref();
});
