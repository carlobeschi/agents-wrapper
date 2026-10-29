// What server.js and season.js share: where things live, the agents config,
// and how a headless agent is started.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const HOME_DIR  = process.env.AGENT_DISPATCH_HOME || path.join(os.homedir(), '.agent-dispatch');
const CONFIG    = process.env.AGENT_DISPATCH_CONFIG
  || (fs.existsSync(path.join(HOME_DIR, 'agents.json')) ? path.join(HOME_DIR, 'agents.json')
                                                         : path.join(__dirname, 'agents.json'));

function loadConfig() {
  // The config decides what runs, so only its owner may be able to change it.
  const st = fs.statSync(CONFIG);
  // Group-writable is fine when the group is the user's own (a umask of 002).
  const groupWrite = (st.mode & 0o020) && !(process.getgid && st.gid === process.getgid());
  if ((process.getuid && st.uid !== process.getuid()) || (st.mode & 0o002) || groupWrite) {
    throw new Error(`${CONFIG} can be changed by other users of this machine; make it yours and run chmod go-w on it.`);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  if (!Array.isArray(cfg.agents)) throw new Error(`${CONFIG}: "agents" must be an array`);
  // A command that names {model} runs that exact model, so it has to be set.
  for (const a of cfg.agents) {
    const named = [...(a.interactive || []), ...(a.headless || [])].some(s => String(s).includes('{model}'));
    if (named && (typeof a.model !== 'string' || !a.model.trim() || a.model.startsWith('-'))) {
      throw new Error(`${CONFIG}: ${a.id} uses {model} but has no "model".`);
    }
  }
  return cfg;
}

// {model} first, so a prompt that happens to contain "{model}" is left as it is.
// Which model each agent runs, as recorded with a run: { id: model }, pinned ones only.
const modelsOf = agents => Object.fromEntries(agents.filter(a => a.model).map(a => [a.id, a.model]));

const fill = (args, prompt, model = '') => args.map(s => s.split('{model}').join(model).split('{prompt}').join(prompt));

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

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Taking out what must not leave the laptop, for season.js and motion.js.
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The home folder and user name are always on the list; the season file adds
// the producer's name and anything else. Longest first, so "Ada Lovelace" goes
// before "Ada".
function redactor(extra = []) {
  const pairs = [[os.homedir(), '~'], [os.userInfo().username, '[redacted]'], ...extra]
    .filter(([find]) => find && find.length > 1)
    .sort((a, b) => b[0].length - a[0].length);
  // Whole words only, in both: "Ada" is not in "adapt", nor a name in a URL that merely starts with it.
  const word = find => new RegExp(`(?<![\\w])${escapeRe(find)}(?![\\w])`, 'gi');
  const redact = text => pairs.reduce((t, [find, put]) => t.replace(word(find), put), String(text));
  const leaks = text => pairs.map(([find]) => find).filter(find => word(find).test(text));
  return { redact, leaks };
}

module.exports = { HOME_DIR, CONFIG, loadConfig, modelsOf, fill, agentEnv, stamp, redactor };
