#!/usr/bin/env node
// @ts-check
// The game jam: `node jam.js <jam.json> [--out=<folder>] [--labs=a,b] [--until=<phase>] [--check]`.
//
// Carlo's "simplified double diamond" (25 Nov), informal, just to see what
// happens: agents from four labs improve a small game he built.
//
//   ideas   (diverge)  every lab proposes 3 new features or improvements,
//                      alone, after reading the game and its README.
//   vote1   (converge) every lab scores the ideas of the others, without
//                      names, in a shuffled order; it never sees its own.
//                      The two with the best average score win.
//   build   (diverge)  every lab builds the same two winning ideas into the
//                      game, in its own git branch (jam/<lab>), alone.
//   vote2   (converge) every lab scores the other labs' builds, without
//                      names: it reads each change, the builder's notes and
//                      our check that the game still opens without errors.
//
// The agents only read files, and in "build" also edit them, inside the run
// folder. No agent can run commands, except Codex, whose sandbox lets it run
// them only inside its own folder, with no network. Nothing is pushed or
// published: the branches stay in the run folder's clone, and
// patches/<lab>.patch holds each one for a person to look at or push.
//
// Config (examples/jam/carolina.json):
// { "title": "...", "repo": "<git URL or folder>", "game": "you-are-a-cat.html",
//   "about": "one paragraph on the game, for every prompt",
//   "labs": ["claude", "codex", "gemini", "mistral"], "ideas_per_lab": 3, "build_top": 2,
//   "build_minutes": 40, "check_clicks": ["GO!"], "mistral_max_price": 2, "mistral_max_tokens": { "read": 1500000, "build": 6000000 }, "models": { "mistral": "..." } }
// Models: Claude, Gemini and Codex use the model of "claude", "antigravity" and
// "codex" in agents.json (the config AGENT_DISPATCH_CONFIG names); "models"
// overrides them. "commands" replaces a lab's commands (for tests), and is
// refused if it loosens permissions.
// Run folder: ~/.agent-dispatch/jam/<stamp>/ (or --out): repo/ (the clone),
// build/<lab>/ (each lab's branch), steps/ (every prompt and reply),
// ideas.json, results.json, summary.md. A phase whose replies are already
// there is not run again, so a stopped run goes on with the same --out.
// --check asks every lab for one tiny read and one tiny write in a scratch
// folder, to see that its commands work before a real run.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { HOME_DIR, loadConfig, agentEnv, fill, noteCall, stamp } = require('./config');
const { killTree, stripAnsi } = require('./talk');

const PHASES = ['ideas', 'vote1', 'build', 'vote2'];

// ---- Each lab's commands ----
// "read" may only read files in its folder; "build" may also edit them.
// {prompt} in a command is the prompt; a command without it gets the prompt on stdin.

const CODEX_SAFE = ['--skip-git-repo-check', '--ignore-user-config', '--ignore-rules'];
const AGY = deny => JSON.stringify({ toolPermission: 'request-review', allowNonWorkspaceAccess: false, enableTerminalSandbox: true,
  permissions: { ...(deny.includes('write_file(*)') ? {} : { allow: ['read_file(*)', 'write_file(*)'] }), deny } });
const AGY_DENY = ['command(*)', 'mcp(*)', 'read_url(*)', 'execute_url(*)', 'download_url(*)'];
// Vibe has no separate search tool (it searches with bash, which stays off).
const VIBE_READ = ['--enabled-tools', 'read_file'];
const VIBE_WRITE = [...VIBE_READ, '--enabled-tools', 'write_file', '--enabled-tools', 'search_replace'];

const LABS = {
  claude: {
    label: 'Claude', from: 'claude', env: ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR'],
    read:  ['claude', '-p', '--model', '{model}', '--tools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk', '--strict-mcp-config'],
    build: ['claude', '-p', '--model', '{model}', '--tools', 'Read,Edit,Write,Glob,Grep', '--permission-mode', 'acceptEdits', '--strict-mcp-config'],
  },
  codex: {
    label: 'Codex', from: 'codex', env: ['OPENAI_API_KEY', 'CODEX_HOME'],
    read:  ['codex', 'exec', '-s', 'read-only', ...CODEX_SAFE, '-m', '{model}', '-'],
    build: ['codex', 'exec', '-s', 'workspace-write', ...CODEX_SAFE, '-c', 'sandbox_workspace_write.network_access=false', '-m', '{model}', '-'],
  },
  gemini: {
    label: 'Gemini', from: 'antigravity', env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT'],
    read:  ['agy', '--model', '{model}', '--sandbox', '--settings', AGY(['write_file(*)', ...AGY_DENY]), '--disable-slash-commands', '-p', '{prompt}'],
    build: ['agy', '--model', '{model}', '--sandbox', '--settings', AGY(AGY_DENY), '--disable-slash-commands', '-p', '{prompt}'],
  },
  mistral: {
    label: 'Mistral', from: null, env: ['MISTRAL_API_KEY', 'VIBE_HOME'],
    read:  ['vibe', '--prompt', '{prompt}', '--model', '{model}', ...VIBE_READ, '--max-price', '{price}', '--max-tokens', '{tokens_read}', '--output', 'text', '--output-dir', '{steps}'],
    build: ['vibe', '--prompt', '{prompt}', '--model', '{model}', ...VIBE_WRITE, '--max-price', '{price}', '--max-tokens', '{tokens_build}', '--output', 'text', '--output-dir', '{steps}'],
  },
};
// DeepSeek: the same Vibe agent and tools as Mistral, with an open model through
// OpenRouter. Vibe gets its own home folder in the run folder (vibeHome), whose
// config.toml names OpenRouter and the model with its prices, so that
// --max-price really stops it (with Mistral's own models Vibe sees a price of 0).
LABS.deepseek = { ...LABS.mistral, label: 'DeepSeek', env: ['OPENROUTER_API_KEY'], vibe: true };
LABS.mistral.vibe = true;
const OPENROUTER_MODELS = { deepseek: { id: 'deepseek/deepseek-v4-pro-0813', input: 0.6, cached: 0.15, output: 2.4 } };

// The config.toml for a Vibe that talks to OpenRouter only. Prices in dollars per million tokens.
function vibeConfig(m) {
  return [
    'active_model = "jam"', '',
    '[[providers]]', 'name = "openrouter"', 'api_base = "https://openrouter.ai/api/v1"', 'api_key_env_var = "OPENROUTER_API_KEY"',
    'api_style = "openai"', 'backend = "generic"', '',
    '[[models]]', `name = ${JSON.stringify(m.id)}`, 'provider = "openrouter"', 'alias = "jam"',
    `input_price = ${m.input}`, `cached_input_price = ${m.cached}`, `output_price = ${m.output}`, '',
  ].join('\n');
}

// Flags that would loosen what an agent may do. A command with any of them is refused.
const LOOSE = /dangerously|bypass|yolo|auto-approve|full-access|danger-full|--allowedTools|--allowed-tools|^bash$|run_command/i;
function refuseLoose(cmd, where) {
  for (const s of cmd) if (LOOSE.test(String(s))) throw new Error(`${where}: "${s}" would loosen the agent's permissions; refused.`);
  if (cmd.includes('--enabled-tools') && cmd.some((s, i) => cmd[i - 1] === '--enabled-tools' && /bash|shell/i.test(s))) throw new Error(`${where}: no shell tool for Vibe.`);
}

// Vibe reports a price of 0 for Mistral models, so --max-price never stops it: a token budget
// does (round 1, 25 Nov: one 40-minute build read 17.6M tokens, about 5 euros a round in all).
const TOKENS = { read: 1500000, build: 6000000 };

// The lab's command, with {model} (or "-m {model}" dropped when there is no model), {price} and {steps} filled in.
function commandFor(lab, mode, { model = '', price = 2, steps = '', tokens = TOKENS } = {}) {
  const cmd = lab[mode].slice();
  if (!model) for (let i = cmd.length - 1; i > 0; i--) if (cmd[i] === '{model}') { cmd.splice(i - 1, 2); i--; }
  const out = cmd.map(s => s.split('{price}').join(String(price)).split('{steps}').join(steps)
    .split('{tokens_read}').join(String(tokens.read)).split('{tokens_build}').join(String(tokens.build)));
  return fill(out, '{prompt}', model);
}

function labsFor(c, only) {
  const cfg = (() => { try { return loadConfig(); } catch { return { agents: [] }; } })();
  const ids = (only || c.labs || Object.keys(LABS)).filter(Boolean);
  return ids.map(id => {
    const base = LABS[id];
    const over = c.commands?.[id];
    if (!base && !over) throw new Error(`unknown lab "${id}" (labs: ${Object.keys(LABS).join(', ')})`);
    const lab = { id, ...(base || { label: id, env: [] }), ...(over || {}) };
    for (const m of ['read', 'build']) { if (!Array.isArray(lab[m])) throw new Error(`lab ${id}: no "${m}" command`); refuseLoose(lab[m], `lab ${id} ${m}`); }
    lab.model = c.models?.[id] ?? (base?.from ? cfg.agents.find(a => a.id === base.from)?.model : '') ?? '';
    const routed = OPENROUTER_MODELS[id];
    if (routed) { lab.routed = { ...routed, ...(c.openrouter_models?.[id] || {}) }; lab.model = 'jam'; }
    return lab;
  });
}

// ---- Running one step ----

const MAX_REPLY = 200000;

function runOnce(lab, mode, prompt, cwd, ms, extra) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const cmd = commandFor(lab, mode, { model: lab.model, ...extra });
    const viaArg = cmd.some(s => s.includes('{prompt}'));
    const [bin, ...args] = cmd.map(s => s.split('{prompt}').join(prompt));
    const cur = { out: '', err: '' };
    let child;
    try {
      noteCall(bin);
      child = spawn(bin, args, { cwd, env: { ...agentEnv(lab.env), ...(lab.vibeHome ? { VIBE_HOME: lab.vibeHome } : {}) }, shell: false, detached: true, stdio: [viaArg ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
      if (!viaArg && child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(prompt); }
    } catch (e) { return resolve({ text: '', why: e.message, err: '', ms: 0 }); }
    const timer = setTimeout(() => { cur.timedOut = true; killTree(child); }, ms);
    child.stdout.on('data', c => { if (cur.out.length < MAX_REPLY) cur.out += c; });
    child.stderr.on('data', c => { cur.err = (cur.err + c).slice(-64000); });
    child.on('error', e => { cur.spawnError = e.message; });
    child.on('close', code => {
      clearTimeout(timer);
      const text = stripAnsi(cur.out).trim();
      const why = cur.spawnError || (cur.timedOut ? 'timed out' : code !== 0 ? `exit ${code}` : !text ? 'empty reply' : null);
      resolve({ text, why, err: cur.err, ms: Date.now() - t0 });
    });
  });
}

// One step, kept in steps/<name>: a reply already there is reused. Returns the reply, or null if it failed twice.
async function step(dir, name, lab, mode, prompt, cwd, ms) {
  const base = path.join(dir, 'steps', name);
  fs.mkdirSync(path.dirname(base), { recursive: true });
  if (fs.existsSync(base + '.reply.md')) return fs.readFileSync(base + '.reply.md', 'utf8');
  fs.writeFileSync(base + '.prompt.md', prompt);
  const extra = { price: lab.price ?? 2, steps: base + '.vibe', tokens: lab.tokens || TOKENS };
  let r = await runOnce(lab, mode, prompt, cwd, ms, extra);
  if (r.why && r.why !== 'timed out' && mode !== 'build') {
    console.warn(`  ↻ ${name}: ${r.why}, once more`);
    r = await runOnce(lab, mode, prompt, cwd, ms, extra);
  }
  if (r.err) fs.writeFileSync(base + '.stderr.txt', r.err);
  fs.writeFileSync(base + '.meta.json', JSON.stringify({ lab: lab.id, model: lab.model || null, mode, ms: r.ms, why: r.why || null }, null, 2));
  if (r.why && !(mode === 'build' && r.why === 'timed out')) {
    if (r.text) fs.writeFileSync(base + '.failed-reply.md', r.text);
    console.warn(`  ✗ ${name}: ${r.why}`);
    return null;
  }
  fs.writeFileSync(base + '.reply.md', r.text || `(no reply: ${r.why})`);
  console.log(`  ✓ ${name}: ${Math.round(r.ms / 1000)}s`);
  return r.text;
}

// ---- Prompts and replies ----

const NAMES = /\b(claude|anthropic|opus|sonnet|haiku|codex|openai|chatgpt|gpt[-\w.]*|gemini|antigravity|google|deepmind|mistral|vibe|devstral|le chat)\b/gi;
const anonymise = s => String(s).replace(NAMES, 'an agent');

const gameIntro = c => [
  `The game: "${c.title}". ${c.about}`,
  `All of it is in one file, ${c.game}, in the current folder; README.md says what it already does. You can read both.`,
].join('\n');

function ideasPrompt(c, n) {
  return [
    `You are one of ${n} AI agents, each from a different AI lab, asked to suggest improvements to a small game.`,
    gameIntro(c),
    '',
    `Propose exactly ${c.ideas_per_lab} ideas for new features or improvements. Each should be something the children who play it would love, or that makes the game clearly better, and that one AI agent can build in one session by editing that file (no new libraries, no network, no server). Don't propose what the game already has.`,
    `Afterwards every agent will score every other agent's ideas, without knowing who proposed them, and the ${c.build_top} best will be built by every agent, each on its own.`,
    '',
    'Write each idea exactly like this, and nothing else:',
    'IDEA: a short title',
    'WHAT: two to four sentences: what the child sees and does',
    'WHY: one sentence',
  ].join('\n');
}

function parseIdeas(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/^[\s>*_#-]*(?:\d+[.)]\s*)?[\s>*_#-]*/, '');
    const m = /^(IDEA|WHAT|WHY)\s*[:\-–]\s*\**\s*(.*)$/i.exec(line);
    if (m) {
      const key = m[1].toLowerCase();
      if (key === 'idea') { cur = { title: m[2].replace(/\*+$/, '').trim(), what: '', why: '' }; out.push(cur); }
      else if (cur) cur[key] = m[2].trim();
    } else if (cur && line.trim() && !/^```/.test(line)) {
      const key = cur.why ? 'why' : cur.what ? 'what' : null;
      if (key) cur[key] += ' ' + line.trim();
    }
  }
  return out.filter(i => i.title && i.what);
}

const seedOf = s => crypto.createHash('sha256').update(String(s)).digest().readUInt32LE(0);
function shuffled(list, seed) {
  let x = seedOf(seed) || 1;
  const r = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// What a voter sees: the others' items in its own shuffled order, numbered from 1.
const ballot = (items, voter, seed) => shuffled(items.filter(i => i.lab !== voter), `${seed}:${voter}`);

function vote1Prompt(c, shown) {
  return [
    `You are one of several AI agents, each from a different AI lab, choosing improvements for a small game.`,
    gameIntro(c),
    '',
    `Here are ${shown.length} ideas from the other agents (none of them is yours). They are shown without names and in a random order.`,
    '',
    ...shown.map((i, k) => `I${k + 1}. ${anonymise(i.title)}\n    What: ${anonymise(i.what)}\n    Why: ${anonymise(i.why)}`),
    '',
    `Score every idea from 1 (would not build it) to 10 (must build it). Think of how much the children who play would enjoy it, how well it fits the game, and whether one agent can build it well in one session. The ${c.build_top} ideas with the best average score will be built.`,
    'Reply with one line per idea and nothing else, like this:',
    'I1: 7 - a reason in a few words',
  ].join('\n');
}

function vote2Prompt(c, ideas, letters) {
  return [
    `You are one of several AI agents, each from a different AI lab. Each agent built the same ${ideas.length} ideas into a small game, on its own. Now you score the others' work.`,
    gameIntro(c),
    '',
    'The ideas that were built:',
    ...ideas.map((i, k) => `${k + 1}. ${anonymise(i.title)}: ${anonymise(i.what)}`),
    '',
    `The other agents' builds (not yours) are in the folders ${letters.join(', ')} in the current folder, without names and in a random order. Each folder has:`,
    '- changes.diff: the change to the game',
    '- notes.md: what the builder says it did and where to find it in the game',
    '- check.md: whether the game still opens without script errors, from a quick automatic check in a browser',
    `- ${c.game}: the whole game after the change`,
    '',
    'Read them. Score each build from 1 to 10: how well it delivers the ideas for a young child, the care and quality of the work, and the risk that it breaks something in the game.',
    'Reply with one line per build, then one line for the best, and nothing else, like this:',
    `${letters[0]}: 7 - a reason in a sentence`,
    `BEST: ${letters[0]} - why, in a sentence`,
  ].join('\n');
}

// "I3: 7 - reason", "**A** | 8/10 | reason". Scores outside 1-10 are dropped.
function parseScores(text, prefix, count) {
  const out = {};
  const re = new RegExp(`^[\\s>*_#|-]*${prefix}\\s*(\\d+|[A-Z])\\b[*_]*\\s*[:|.)\\-–]+\\s*[*_]*\\s*(\\d{1,2})(?:\\s*/\\s*10)?[*_]*\\s*[|\\-–:]*\\s*(.*)$`, 'i');
  for (const line of String(text).split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    const key = /^\d+$/.test(m[1]) ? Number(m[1]) : m[1].toUpperCase();
    const score = Number(m[2]);
    if (score < 1 || score > 10 || key in out) continue;
    if (typeof key === 'number' && (key < 1 || key > count)) continue;
    out[key] = { score, why: m[3].replace(/[*_]+/g, '').trim() };
  }
  return out;
}
const parseBest = text => { const m = /^[\s>*_#|-]*BEST\s*[*_]*\s*[:\-–]\s*[*_]*\s*([A-Z])\b[*_]*\s*[-–:]?\s*(.*)$/im.exec(String(text)); return m ? { letter: m[1].toUpperCase(), why: m[2].trim() } : null; };

// Each item's scores from the others and its average; best first. Ties: more scores, then the order given.
// Ties go by number of votes, then by a draw seeded with the run (never by lab order, which would favour the first lab).
function tally(items, votes, seed = '') {
  const rows = items.map((it, k) => {
    const by = Object.fromEntries(Object.entries(votes).map(([voter, v]) => [voter, v[it.key]]).filter(([, s]) => s));
    const scores = Object.values(by).map(s => s.score);
    return { ...it, by, n: scores.length, mean: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null, order: seedOf(`${seed}:${it.id ?? k}`) };
  });
  return rows.sort((a, b) => (b.mean ?? -1) - (a.mean ?? -1) || b.n - a.n || a.order - b.order);
}

function buildPrompt(c, ideas, canRun) {
  return [
    `You are improving a small game. ${gameIntro(c)}`,
    '',
    `In a vote among AI agents from several labs, these ${ideas.length} ideas came top. Build all of them into the game:`,
    ...ideas.map((i, k) => `${k + 1}. ${i.title}\n   What: ${i.what}\n   Why: ${i.why}`),
    '',
    'The current folder is a git branch only for you. Other agents are building the same ideas, each on its own; afterwards every agent will score the others\' builds, without names.',
    'Rules:',
    `- Change only files in this folder. Keep the game in ${c.game}; add a short paragraph to README.md about what you added, in the same plain style.`,
    '- Young children play it on phones and tablets: keep it visual and tap-based, with very little reading.',
    '- Don\'t break what is there, or progress saved on the device. No network, no new libraries, no server.',
    canRun ? '- You can run commands in this folder, with no network.' : '- You cannot run commands or open a browser, so read the code carefully before you change it.',
    '',
    'When you are done, reply with:',
    'WHAT I BUILT: a few sentences',
    'HOW TO SEE IT: where in the game to go and what to tap, for each idea',
    'NOT DONE: anything you left out, or "nothing"',
  ].join('\n');
}

// ---- The game after a build: does it open without script errors? ----

async function checkGame(file, shot, clicks = []) {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { try { ({ chromium } = require('@playwright/test')); } catch { return { checked: false, why: 'Playwright not installed' }; } }
  let browser;
  try {
    // JAM_CHROME: a Chromium to use instead of Playwright's own (a machine whose browsers are another version).
    browser = await chromium.launch(process.env.JAM_CHROME ? { executablePath: process.env.JAM_CHROME } : {});
    const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message || e).split('\n')[0]));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text().split('\n')[0]); });
    await page.route(/^https?:/, r => r.abort());
    await page.goto('file://' + file);
    await page.waitForTimeout(2500);
    // The config's "check_clicks" (text on buttons, tapped in order, if there), then a few taps around the screen.
    for (const t of clicks) { await page.getByText(t, { exact: false }).first().click({ timeout: 1500 }).catch(() => {}); await page.waitForTimeout(800); }
    for (const [x, y] of [[210, 430], [210, 600], [210, 300]]) { await page.mouse.click(x, y); await page.waitForTimeout(600); }
    if (shot) await page.screenshot({ path: shot });
    return { checked: true, errors: [...new Set(errors.filter(e => !/net::ERR_FAILED|ERR_INTERNET|Failed to load resource/i.test(e)))] };
  } catch (e) {
    return { checked: false, why: String(e.message || e).split('\n')[0] };
  } finally { if (browser) await browser.close().catch(() => {}); }
}

// ---- The run ----

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const BOT = ['-c', 'user.name=jam', '-c', 'user.email=jam@users.noreply.github.com', '-c', 'commit.gpgsign=false'];

function setupRepo(c, dir) {
  const repo = path.join(dir, 'repo');
  if (!fs.existsSync(path.join(repo, '.git'))) {
    const src = /^[\w+.-]+:\/\//.test(c.repo) || c.repo.startsWith('git@') ? c.repo : path.resolve(c.repo);
    execFileSync('git', ['clone', '--quiet', ...(fs.existsSync(src) ? [] : ['--depth', '1']), src, repo], { stdio: 'inherit' });
  }
  return repo;
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = k => argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const file = argv.find(a => !a.startsWith('--'));
  if (!file) { console.error('usage: node jam.js <jam.json> [--out=<folder>] [--labs=a,b] [--until=ideas|vote1|build|vote2] [--check]'); process.exit(2); }
  const c = { ideas_per_lab: 3, build_top: 2, build_minutes: 40, read_minutes: 15, mistral_max_price: 2, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  const labs = labsFor(c, opt('labs')?.split(','));
  // A lab routed through OpenRouter needs the key in this shell; without it the lab fails every step in a second and the jam runs on without it.
  const noKey = labs.filter(l => l.routed && !process.env.OPENROUTER_API_KEY).map(l => l.label);
  if (noKey.length) { console.error(`${noKey.join(', ')} needs OPENROUTER_API_KEY in this shell (export it first).`); process.exit(2); }
  for (const l of labs) { l.price = c.mistral_max_price; l.tokens = { ...TOKENS, ...(c.mistral_max_tokens || {}) }; }
  if (argv.includes('--check')) return check(labs);
  const until = opt('until') || 'vote2';
  if (!PHASES.includes(until)) throw new Error(`--until must be one of ${PHASES.join(', ')}`);
  const dir = path.resolve(opt('out') || path.join(HOME_DIR, 'jam', stamp()));
  fs.mkdirSync(dir, { recursive: true });
  homesFor(labs, dir);
  console.log(`Run folder: ${dir}\nLabs: ${labs.map(l => `${l.label}${l.model ? ` (${l.model})` : ''}`).join(', ')}`);
  const repo = setupRepo(c, dir);
  const seed = c.seed ?? path.basename(dir);
  const R = { title: c.title, labs: labs.map(l => ({ id: l.id, label: l.label, model: l.model || null })), started: new Date().toISOString() };
  const save = () => { fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(R, null, 2)); fs.writeFileSync(path.join(dir, 'summary.md'), summaryMd(c, R)); };
  const readMs = c.read_minutes * 60000;

  // 1. Ideas
  console.log('\n1. Ideas');
  const replies = await Promise.all(labs.map(l => step(dir, `ideas/${l.id}`, l, 'read', ideasPrompt(c, labs.length), repo, readMs)));
  const ideas = [];
  labs.forEach((l, k) => parseIdeas(replies[k] || '').slice(0, c.ideas_per_lab).forEach((i, j) => ideas.push({ key: 0, id: `${l.id}-${j + 1}`, lab: l.id, ...i })));
  ideas.forEach((i, k) => { i.key = k; });
  R.ideas = ideas;
  fs.writeFileSync(path.join(dir, 'ideas.json'), JSON.stringify(ideas, null, 2));
  save();
  if (until === 'ideas' || ideas.length < c.build_top) return done(dir, ideas.length < c.build_top ? 'too few ideas to vote on' : '');

  // 2. Vote on ideas
  console.log('\n2. Vote on the ideas');
  const votes1 = {};
  await Promise.all(labs.map(async l => {
    const shown = ballot(ideas, l.id, seed);
    if (!shown.length) return;
    const text = await step(dir, `vote1/${l.id}`, l, 'read', vote1Prompt(c, shown), repo, readMs);
    const got = parseScores(text || '', 'I', shown.length);
    votes1[l.id] = Object.fromEntries(Object.entries(got).map(([n, s]) => [shown[Number(n) - 1].key, s]));
    R.ballots = { ...(R.ballots || {}), [l.id]: shown.map(i => i.id) };
  }));
  R.votes1 = votes1;
  R.ranking = tally(ideas, votes1, seed).map(r => ({ id: r.id, lab: r.lab, title: r.title, mean: r.mean, n: r.n, by: r.by }));
  const winners = R.ranking.slice(0, c.build_top).map(r => ideas.find(i => i.id === r.id));
  R.winners = winners.map(i => i.id);
  save();
  if (until === 'vote1') return done(dir);

  // 3. Build
  console.log(`\n3. Build: ${winners.map(i => i.title).join(' + ')}`);
  const base = git(repo, 'rev-parse', 'HEAD');
  const builds = {};
  fs.mkdirSync(path.join(dir, 'patches'), { recursive: true });
  const baseCheck = await checkGame(path.join(repo, c.game), path.join(dir, 'base.png'), c.check_clicks);
  R.base_check = baseCheck;
  await Promise.all(labs.map(async l => {
    const wt = path.join(dir, 'build', l.id);
    if (!fs.existsSync(wt)) git(repo, 'worktree', 'add', '-q', '-b', `jam/${l.id}`, wt, base);
    const t0 = Date.now();
    const text = await step(dir, `build/${l.id}`, l, 'build', buildPrompt(c, winners, l.id === 'codex'), wt, c.build_minutes * 60000);
    git(wt, 'add', '-A');
    if (git(wt, 'status', '--porcelain')) git(wt, ...BOT, 'commit', '-q', '-m', `jam: ${l.label} builds ${winners.map(i => i.title).join(' + ')}`);
    const files = git(wt, 'diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean);
    const stat = git(wt, 'diff', '--numstat', base, 'HEAD').split('\n').filter(Boolean).map(s => s.split('\t'));
    fs.writeFileSync(path.join(dir, 'patches', `${l.id}.patch`), files.length ? git(wt, 'format-patch', '--stdout', `${base}..HEAD`) : '');
    const chk = files.length ? await checkGame(path.join(wt, c.game), path.join(dir, `build-${l.id}.png`), c.check_clicks) : { checked: false, why: 'nothing changed' };
    const newErrors = chk.checked ? chk.errors.filter(e => !(baseCheck.errors || []).includes(e)) : [];
    builds[l.id] = { ok: text != null, files, added: stat.reduce((s, r) => s + (Number(r[0]) || 0), 0), removed: stat.reduce((s, r) => s + (Number(r[1]) || 0), 0),
      outside: files.filter(f => f !== c.game && f !== 'README.md'), check: chk, new_errors: newErrors, notes: text || '', minutes: Math.round((Date.now() - t0) / 6000) / 10 };
  }));
  R.builds = builds;
  save();
  if (until === 'build') return done(dir);

  // 4. Vote on builds
  console.log('\n4. Vote on the builds');
  const built = labs.filter(l => builds[l.id]?.files.length).map(l => ({ key: l.id, lab: l.id }));
  const votes2 = {}, best = {};
  await Promise.all(labs.map(async l => {
    const shown = ballot(built, l.id, `${seed}:b`);
    if (!shown.length) return;
    const letters = shown.map((_, k) => String.fromCharCode(65 + k));
    const view = path.join(dir, 'vote2', l.id);
    shown.forEach((b, k) => {
      const f = path.join(view, letters[k]);
      fs.mkdirSync(f, { recursive: true });
      const wt = path.join(dir, 'build', b.lab), info = builds[b.lab];
      fs.writeFileSync(path.join(f, 'changes.diff'), anonymise(git(wt, 'diff', base, 'HEAD')));
      fs.writeFileSync(path.join(f, 'notes.md'), anonymise(info.notes || '(no notes)'));
      fs.writeFileSync(path.join(f, 'check.md'), checkMd(info, R.base_check));
      fs.copyFileSync(path.join(wt, c.game), path.join(f, c.game));
    });
    const text = await step(dir, `vote2/${l.id}`, l, 'read', vote2Prompt(c, winners, letters), view, readMs);
    const got = parseScores(text || '', '', 0);
    votes2[l.id] = Object.fromEntries(Object.entries(got).filter(([k]) => letters.includes(k)).map(([k, s]) => [shown[letters.indexOf(k)].key, s]));
    const b = parseBest(text || '');
    if (b && letters.includes(b.letter)) best[l.id] = { lab: shown[letters.indexOf(b.letter)].lab, why: b.why };
    R.ballots2 = { ...(R.ballots2 || {}), [l.id]: Object.fromEntries(letters.map((x, k) => [x, shown[k].lab])) };
  }));
  R.votes2 = votes2;
  R.best = best;
  R.build_ranking = tally(built, votes2, `${seed}:b`).map(r => ({ lab: r.lab, mean: r.mean, n: r.n, by: r.by }));
  R.finished = new Date().toISOString();
  save();
  done(dir);
}

const checkMd = (b, base) => !b.check?.checked ? `Not checked: ${b.check?.why || 'unknown'}.`
  : b.new_errors.length ? `The game opens, but with ${b.new_errors.length} new script error(s) that the original game does not have:\n${b.new_errors.map(e => `- ${e}`).join('\n')}`
  : `The game opens with no new script errors${base?.errors?.length ? ' (the original game has the same ones)' : ''}. Only the first screens were tried; this says nothing about the new features.`;

function done(dir, why = '') { console.log(`\n${why ? why + '. ' : ''}Summary: ${path.join(dir, 'summary.md')}`); }

// ---- Summary ----

const f1 = x => x == null ? '–' : x.toFixed(1);

function summaryMd(c, R) {
  const lab = id => R.labs.find(l => l.id === id)?.label || id;
  const L = [`# Game jam: ${c.title}`, '', `Labs: ${R.labs.map(l => `${l.label}${l.model ? ` (${l.model})` : ''}`).join(', ')}.`, '',
    'Informal: one run, no repeats. Authors are shown here; the agents never saw them.', ''];
  if (R.ranking) {
    const voters = R.labs.map(l => l.id);
    L.push('## Ideas and the vote', '', `| # | Idea | By | Average | ${voters.map(lab).join(' | ')} |`, `|---|---|---|---|${voters.map(() => '---').join('|')}|`);
    R.ranking.forEach((r, k) => L.push(`| ${k + 1}${R.winners.includes(r.id) ? ' ✓' : ''} | ${r.title} | ${lab(r.lab)} | ${f1(r.mean)} | ${voters.map(v => v === r.lab ? '(own)' : r.by[v]?.score ?? '–').join(' | ')} |`));
    L.push('', '✓ = built by everyone.', '');
  } else if (R.ideas) {
    L.push('## Ideas', '', ...R.ideas.map(i => `- **${i.title}** (${lab(i.lab)}): ${i.what}`), '');
  }
  if (R.ideas) L.push('### The ideas in full', '', ...R.ideas.map(i => `- **${i.title}** (${lab(i.lab)}): ${i.what} _${i.why}_`), '');
  if (R.builds) {
    L.push('## Builds', '', '| Lab | Finished | Minutes | Lines +/− | Other files | Game opens | New script errors |', '|---|---|---|---|---|---|---|');
    for (const l of R.labs) {
      const b = R.builds[l.id];
      if (!b) continue;
      L.push(`| ${l.label} | ${b.ok ? 'yes' : 'no'} | ${b.minutes} | +${b.added} / −${b.removed} | ${b.outside.join(', ') || '–'} | ${b.check.checked ? 'yes' : `not checked (${b.check.why})`} | ${b.check.checked ? b.new_errors.length : '–'} |`);
    }
    L.push('', `Branches: jam/<lab> in ${'`repo/`'} of the run folder; patches/<lab>.patch. Screenshots: build-<lab>.png (base.png = before).`, '');
  }
  if (R.build_ranking) {
    const voters = R.labs.map(l => l.id);
    L.push('## The vote on the builds', '', `| Build by | Average | ${voters.map(lab).join(' | ')} | Called best by |`, `|---|---|${voters.map(() => '---').join('|')}|---|`);
    for (const r of R.build_ranking) {
      const fans = Object.entries(R.best || {}).filter(([, b]) => b.lab === r.lab).map(([v]) => lab(v));
      L.push(`| ${lab(r.lab)} | ${f1(r.mean)} | ${voters.map(v => v === r.lab ? '(own)' : r.by[v]?.score ?? '–').join(' | ')} | ${fans.join(', ') || '–'} |`);
    }
    L.push('', '### Why (from the votes)', '');
    for (const [v, got] of Object.entries(R.votes2 || {})) for (const [b, s] of Object.entries(got)) L.push(`- ${lab(v)} on ${lab(b)}: ${s.score}, ${s.why}`);
    L.push('');
  }
  return L.join('\n');
}

// ---- --check: one tiny read and one tiny write per lab ----

// A Vibe home with its own config for each lab whose model goes through OpenRouter.
function homesFor(labs, dir) {
  for (const l of labs.filter(x => x.routed)) {
    l.vibeHome = path.join(dir, 'vibe-home', l.id);
    fs.mkdirSync(l.vibeHome, { recursive: true });
    fs.writeFileSync(path.join(l.vibeHome, 'config.toml'), vibeConfig(l.routed));
  }
}

async function check(labs) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-check-'));
  homesFor(labs, scratch);
  let bad = 0;
  await Promise.all(labs.map(async l => {
    const d = path.join(scratch, l.id);
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'word.txt'), 'pineapple\n');
    const r = await runOnce(l, 'read', 'Read the file word.txt in the current folder and reply with the word in it, nothing else.', d, 5 * 60000, { price: 0.2, steps: path.join(d, '.vibe-read') });
    const w = await runOnce(l, 'build', 'Create a file named hello.txt in the current folder containing exactly the word hi. Do nothing else.', d, 5 * 60000, { price: 0.2, steps: path.join(d, '.vibe-build') });
    const readOk = /pineapple/i.test(r.text || '');
    const wrote = fs.existsSync(path.join(d, 'hello.txt')) && /hi/i.test(fs.readFileSync(path.join(d, 'hello.txt'), 'utf8'));
    if (!readOk || !wrote) bad++;
    console.log(`${l.label}${l.model ? ` (${l.model})` : ''}: read ${readOk ? 'ok' : `FAILED (${r.why || 'wrong reply'})`}, write ${wrote ? 'ok' : `FAILED (${w.why || 'no file'})`}`);
    if (!readOk || !wrote) console.log(`  ${stripAnsi((r.err || w.err || r.text || w.text || '').trim()).split('\n').slice(-3).join('\n  ')}`);
  }));
  // An agent's background process can still be writing in the scratch folder; a failed clean-up must not stop the run.
  try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch (e) { console.log(`(could not remove ${scratch}: ${e.code || e.message})`); }
  if (bad) process.exitCode = 1;
}

module.exports = { LABS, vibeConfig, OPENROUTER_MODELS, commandFor, labsFor, refuseLoose, parseIdeas, parseScores, parseBest, tally, ballot, anonymise, ideasPrompt, vote1Prompt, vote2Prompt, buildPrompt, summaryMd };

if (require.main === module) main().catch(e => { console.error(e.message || e); process.exit(1); });
