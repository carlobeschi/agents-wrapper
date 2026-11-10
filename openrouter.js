#!/usr/bin/env node
// OpenRouter as a text-only agent: `node openrouter.js --model <id>`, prompt
// on stdin, reply on stdout. It sends one chat message and prints the answer.
// No tools, no files, no shell: the model can only write text, which the app
// (room.js, study.js, ...) parses. The key comes from OPENROUTER_API_KEY (on
// the laptop: from the Keychain, service "openrouter-key"); it is never
// written anywhere.
//
// In a study or room config, name an agent "openrouter:<model id>", e.g.
// "openrouter:qwen/qwen3-max" (or "openrouter:<id>#2" for a second copy).
// `node openrouter.js --list [filter]` lists the models with their prices.
// Every call's token counts and cost (as OpenRouter reports them) are
// appended to ~/.agent-dispatch/openrouter-usage.jsonl.

const fs = require('fs');
const path = require('path');
const { HOME_DIR } = require('./config');

const BASE = process.env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1';
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };

async function list(filter) {
  const r = await fetch(`${BASE}/models`);
  if (!r.ok) throw new Error(`models: HTTP ${r.status}`);
  const per = x => Math.round(Number(x || 0) * 1e6 * 100) / 100;
  const rows = (await r.json()).data.filter(m => !filter || m.id.includes(filter)).sort((a, b) => (b.created || 0) - (a.created || 0));
  for (const m of rows) console.log(`${m.id}\t$${per(m.pricing?.prompt)}/M in\t$${per(m.pricing?.completion)}/M out\t${m.context_length || ''}`);
}

async function ask(model, prompt) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is not set');
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'agents-wrapper' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], usage: { include: true } }),
    signal: AbortSignal.timeout(Number(process.env.OPENROUTER_TIMEOUT_MS || 600000)),
  });
  const body = await r.text();
  let j; try { j = JSON.parse(body); } catch { throw new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`); }
  if (!r.ok || j.error) throw new Error(`HTTP ${r.status}: ${j.error?.message || body.slice(0, 200)}`);
  const u = j.usage || {};
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.appendFileSync(path.join(HOME_DIR, 'openrouter-usage.jsonl'), JSON.stringify({ at: new Date().toISOString(), model: j.model || model,
      prompt_tokens: u.prompt_tokens ?? null, completion_tokens: u.completion_tokens ?? null, cost: u.cost ?? null }) + '\n');
  } catch {}
  const text = j.choices?.[0]?.message?.content;
  if (!text) throw new Error('empty reply');
  return text;
}

// The agent an "openrouter:<model>" name stands for (see room.js resolveAgent).
const agentFor = model => ({ id: `openrouter-${model.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}`, label: model.split('/').pop(), model,
  headless: [process.execPath, path.join(__dirname, 'openrouter.js'), '--model', '{model}'], stdin: true, env: ['OPENROUTER_API_KEY', 'OPENROUTER_BASE', 'AGENT_DISPATCH_HOME'] });

// Total reported cost in the usage log, optionally since a time.
function spent(since) {
  try {
    return fs.readFileSync(path.join(HOME_DIR, 'openrouter-usage.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
      .filter(r => !since || r.at >= since).reduce((sum, r) => sum + (r.cost || 0), 0);
  } catch { return 0; }
}

module.exports = { agentFor, ask, spent };

if (require.main === module) {
  (async () => {
    if (process.argv.includes('--list')) return list(process.argv[process.argv.indexOf('--list') + 1]);
    if (process.argv.includes('--spent')) return console.log(`$${spent(arg('--spent')).toFixed(4)} reported by OpenRouter`);
    const model = arg('--model');
    if (!model) { console.error('usage: node openrouter.js --model <id> < prompt  |  --list [filter]  |  --spent [since ISO time]'); process.exit(2); }
    const prompt = fs.readFileSync(0, 'utf8');
    process.stdout.write((await ask(model, prompt)).trim() + '\n');
  })().catch(e => { console.error(e.message); process.exit(1); });
}
