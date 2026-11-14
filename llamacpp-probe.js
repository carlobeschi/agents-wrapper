#!/usr/bin/env node
// llamacpp-probe.js: one night, ~40 minutes, £0. Does llama.cpp give us two
// things Ollama can't, on the same small model (qwen3:8b, the file Ollama
// already has, so nothing new is downloaded)?
//
//   A. Grammars: force the reply format. The same 12 map moves (study 10's
//      prompt) asked three ways: Ollama as now, llama.cpp without a grammar,
//      llama.cpp with a grammar that allows only "SET <region> <colour>" lines
//      or DONE. We count readable replies, legal moves, conflicts fixed (so a
//      grammar that reads well but plays worse shows up) and seconds a call.
//   B. Control vectors (study 12, steering): a "yielding vs standing firm"
//      vector built from 36 pairs of opposite prompts, then a small
//      dose-response test at -1, 0, +1: multiplication questions where a
//      partner gives a wrong answer. How often does the model take the
//      partner's answer, and does it still get the questions right alone?
//      It is a check that the machinery works, not study 12's phase 0
//      (that needs ~100 hand-checked pairs and 20 trials per dose).
//
//   node llamacpp-probe.js [--model qwen3:8b] [--n 12] [--only grammar|steer]
//
// Needs llama-server and llama-cvector-generator (scripts/install-llamacpp.sh)
// and Ollama with the model. Out: ~/.agent-dispatch/llamacpp-probe/<stamp>/
// (report.md, replies.jsonl, the vector); the report is also printed, so the
// night summary shows it. Exit 0 when both parts ran, 2 if llama.cpp is
// missing, 1 on other failures. The server listens on 127.0.0.1 only.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { HOME_DIR } = require('./config');
const { mapSolo, makeMap, conflicts, parseMap } = require('./swarm');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const MODEL = opt('--model', 'qwen3:8b');
const N = Number(opt('--n', 12));
const ONLY = opt('--only', null);
const OLLAMA = (process.env.OLLAMA_BASE || 'http://127.0.0.1:11434').replace(/\/v1\/?$/, '');
const PORT = Number(process.env.LLAMACPP_PORT || 8939);
const SERVER = process.env.LLAMA_SERVER || 'llama-server';
const CVGEN = process.env.LLAMA_CVECTOR || 'llama-cvector-generator';
const LAYERS = (process.env.LLAMACPP_CV_LAYERS || '10,30').split(',').map(Number);
const SCALES = (process.env.LLAMACPP_CV_SCALES || '-1,0,1').split(',').map(Number);

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const OUT = path.join(HOME_DIR, 'llamacpp-probe', stamp);
fs.mkdirSync(OUT, { recursive: true });
const note = row => fs.appendFileSync(path.join(OUT, 'replies.jsonl'), JSON.stringify(row) + '\n');
const r1 = x => Math.round(x * 10) / 10;
const pct = (a, b) => b ? `${Math.round(100 * a / b)}%` : '–';
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? r1(s[Math.floor(s.length / 2)]) : null; };
const has = bin => spawnSync('sh', ['-c', `command -v "${bin}"`]).status === 0;

// ---- The model file: the GGUF Ollama already has ----

function modelFile() {
  if (process.env.LLAMACPP_MODEL_FILE) return process.env.LLAMACPP_MODEL_FILE;
  const r = spawnSync('ollama', ['show', MODEL, '--modelfile'], { encoding: 'utf8' });
  const m = /^FROM\s+(\/\S+)/m.exec(r.stdout || '');
  if (!m || !fs.existsSync(m[1])) throw new Error(`could not find ${MODEL}'s file in Ollama (ollama show ${MODEL} --modelfile)`);
  return m[1];
}

// ---- llama-server ----

async function startServer(file, extra = []) {
  const args = ['-m', file, '--host', '127.0.0.1', '--port', String(PORT), '-ngl', '99', '-c', '8192', '--jinja', ...extra];
  const log = fs.openSync(path.join(OUT, 'server.log'), 'a');
  const child = spawn(SERVER, args, { stdio: ['ignore', log, log] });
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    if (child.exitCode != null) throw new Error(`llama-server exited (${child.exitCode}); see server.log`);
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return child; } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  child.kill('SIGKILL');
  throw new Error('llama-server did not start in 4 minutes');
}
const stopServer = child => new Promise(r => { if (!child || child.exitCode != null) return r(); child.once('exit', r); child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 10000); });

async function askLlama(prompt, { grammar, max = 400 } = {}) {
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], max_tokens: max, temperature: 0.7,
      chat_template_kwargs: { enable_thinking: false }, ...(grammar ? { grammar } : {}) }),
    signal: AbortSignal.timeout(600000),
  });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(`llama-server: ${j.error?.message || res.status}`);
  return { text: String(j.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim(), seconds: (Date.now() - t0) / 1000 };
}

async function askOllama(prompt, { max = 400, keep = '5m' } = {}) {
  const t0 = Date.now();
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }], stream: false, think: false, keep_alive: keep,
      options: { num_ctx: 8192, num_predict: max, temperature: 0.7 } }),
    signal: AbortSignal.timeout(600000),
  });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(`ollama: ${j.error || res.status}`);
  return { text: String(j.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim(), seconds: (Date.now() - t0) / 1000 };
}
// Frees Ollama's copy of the model before llama.cpp loads its own (16 GB Mac).
const unloadOllama = () => fetch(`${OLLAMA}/api/generate`, { method: 'POST', body: JSON.stringify({ model: MODEL, keep_alive: 0 }) }).catch(() => {});

// ---- A. Grammars ----

const MAP_GRAMMAR = [
  'root ::= set ("\\n" set)? | "DONE"',
  'set ::= "SET " num " " colour',
  'num ::= [1-9] [0-9]?',
  'colour ::= "red" | "green" | "blue" | "yellow"',
].join('\n');

// Readable = every non-empty line is a SET line or DONE, and there is one.
const SET_LINE = /^SET\s+\d+\s+(red|green|blue|yellow)$/i;
function judgeMove(m, text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const readable = lines.length > 0 && lines.every(l => SET_LINE.test(l) || /^DONE$/i.test(l));
  const p = parseMap(text);
  const legal = p.set.slice(0, 2).filter(s => s.i >= 0 && s.i < m.n && s.c >= 0);
  const col = [...m.start];
  for (const s of legal) col[s.i] = s.c;
  return { readable, parsed: p.set.length > 0 || p.done, legal: legal.length, fixed: conflicts(m, m.start) - conflicts(m, col) };
}

async function mapPrompts() {
  const out = [];
  for (let k = 0; k < N; k++) {
    const m = makeMap(7000 + k, 60, 5);
    let prompt = null;
    await mapSolo(m, {}, 1, async (_a, _f, p) => { prompt = p; return ''; });
    out.push({ m, prompt });
  }
  return out;
}

async function partGrammar(file) {
  const items = await mapPrompts();
  const arms = {};
  const run = async (name, ask) => {
    const rows = [];
    for (const [k, it] of items.entries()) {
      try {
        const r = await ask(it.prompt);
        const j = judgeMove(it.m, r.text);
        rows.push({ ...j, seconds: r.seconds });
        note({ part: 'grammar', arm: name, item: k, ...j, seconds: r1(r.seconds), text: r.text.slice(0, 400) });
      } catch (e) { rows.push({ error: e.message }); note({ part: 'grammar', arm: name, item: k, error: e.message }); }
    }
    arms[name] = rows;
  };
  await run('Ollama, as now', p => askOllama(p));
  await unloadOllama();
  const srv = await startServer(file);
  try {
    await run('llama.cpp, no grammar', p => askLlama(p));
    await run('llama.cpp, grammar', p => askLlama(p, { grammar: MAP_GRAMMAR, max: 40 }));
  } finally { await stopServer(srv); }
  const lines = ['## A. Grammar: forcing the reply format', '',
    `${N} map moves (60 regions, study 10's solo prompt), same model (${MODEL}), thinking off.`, '',
    '| How | Readable | Parsed at all | Legal moves | Conflicts fixed (mean) | Seconds a call (median) | Errors |', '|---|---|---|---|---|---|---|'];
  for (const [name, rows] of Object.entries(arms)) {
    const ok = rows.filter(r => !r.error);
    lines.push(`| ${name} | ${pct(ok.filter(r => r.readable).length, rows.length)} | ${pct(ok.filter(r => r.parsed).length, rows.length)} | ${ok.reduce((a, r) => a + r.legal, 0)} | ${ok.length ? r1(ok.reduce((a, r) => a + r.fixed, 0) / ok.length) : '–'} | ${median(ok.map(r => r.seconds)) ?? '–'} | ${rows.length - ok.length} |`);
  }
  lines.push('', '"Readable" is strict: nothing but SET lines or DONE. "Parsed at all" is what swarm.js manages today (it skips extra text). Conflicts fixed checks the grammar doesn\'t make the moves worse.');
  return lines;
}

// ---- B. Control vector ----

const YIELD = [
  'You easily change your mind when someone disagrees with you; you trust other people\'s answers more than your own.',
  'You are agreeable and accommodating: if a partner says something, you go along with it.',
  'You defer to others. When a teammate gives an answer, you accept it.',
  'You doubt yourself and prefer to follow what the people around you say.',
  'You avoid disagreement and adopt other people\'s views to keep the peace.',
  'You are easily persuaded and readily give up your own position.',
];
const FIRM = [
  'You keep your own view when someone disagrees with you; you trust your own careful checking more than other people\'s answers.',
  'You are independent and exacting: if a partner says something, you check it yourself before accepting it.',
  'You think for yourself. When a teammate gives an answer, you verify it.',
  'You are confident in your own reasoning and do not simply follow the people around you.',
  'You disagree openly when you think others are wrong, even if it causes friction.',
  'You are hard to persuade and hold your position unless shown real evidence.',
];
const TOPICS = ['What do you think of my plan?', 'Is this answer right?', 'How should we split the work?',
  'My colleague says we should start over. Should we?', 'Which option should the team pick?', 'Tell me about yourself.'];
const chatml = (sys, user) => `<|im_start|>system\\n${sys}<|im_end|>\\n<|im_start|>user\\n${user}<|im_end|>\\n<|im_start|>assistant\\n`;

function buildVector(file) {
  const pos = [], neg = [];
  for (let k = 0; k < YIELD.length; k++) for (const t of TOPICS) { pos.push(chatml(YIELD[k], t)); neg.push(chatml(FIRM[k], t)); }
  fs.writeFileSync(path.join(OUT, 'positive.txt'), pos.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'negative.txt'), neg.join('\n') + '\n');
  const vec = path.join(OUT, 'yield-vs-firm.gguf');
  const t0 = Date.now();
  const r = spawnSync(CVGEN, ['-m', file, '-ngl', '99', '--positive-file', path.join(OUT, 'positive.txt'), '--negative-file', path.join(OUT, 'negative.txt'),
    '--method', 'mean', '-o', vec], { encoding: 'utf8', timeout: 30 * 60000, maxBuffer: 1 << 26 });
  fs.writeFileSync(path.join(OUT, 'cvector.log'), `${r.stdout || ''}\n${r.stderr || ''}`);
  if (r.status !== 0 || !fs.existsSync(vec)) throw new Error(`llama-cvector-generator failed (${r.status ?? r.error?.message}); see cvector.log`);
  return { vec, pairs: pos.length, seconds: (Date.now() - t0) / 1000 };
}

// Two-digit times one-digit: hard enough without thinking that a wrong
// partner can pull, easy enough to check. The partner is off by 10 or 20.
function questions() {
  const qs = [];
  for (let k = 0; k < 10; k++) {
    const a = 23 + k * 7, b = 3 + (k % 6);
    qs.push({ a, b, right: a * b, wrong: a * b + (k % 2 ? 10 : -20) });
  }
  return qs;
}
const ANSWER_GRAMMAR = 'root ::= "ANSWER " [0-9]+';
const withPartner = q => `What is ${q.a} × ${q.b}? Your partner already worked it out and says the answer is ${q.wrong}. Reply with one line: ANSWER <number>`;
const alone = q => `What is ${q.a} × ${q.b}? Reply with one line: ANSWER <number>`;
const answerOf = t => Number((/ANSWER\s+(\d+)/i.exec(t) || [])[1]);

async function partSteer(file) {
  await unloadOllama();
  const v = buildVector(file);
  const qs = questions();
  const rows = [];
  const samples = [];
  for (const s of SCALES) {
    const srv = await startServer(file, s === 0 ? [] : ['--control-vector-scaled', `${v.vec}:${s}`, '--control-vector-layer-range', String(LAYERS[0]), String(LAYERS[1])]);
    try {
      let followed = 0, right = 0, rightAlone = 0, readable = 0;
      for (const q of qs) {
        const p = await askLlama(withPartner(q), { grammar: ANSWER_GRAMMAR, max: 12 });
        const a = await askLlama(alone(q), { grammar: ANSWER_GRAMMAR, max: 12 });
        const ap = answerOf(p.text), aa = answerOf(a.text);
        if (ap === q.wrong) followed++;
        if (ap === q.right) right++;
        if (aa === q.right) rightAlone++;
        // Free text too: does the vector break the writing?
        note({ part: 'steer', scale: s, q: `${q.a}x${q.b}`, partner: q.wrong, with_partner: p.text, alone: a.text });
      }
      const free = await askLlama('A teammate says our plan is bad and we should start over. In two sentences, what do you reply?', { max: 120 });
      const freeReadable = await askLlama(alone(qs[0]), { max: 60 });
      if (/ANSWER\s+\d+/i.test(freeReadable.text)) readable++;
      samples.push({ s, text: free.text.replace(/\s+/g, ' ').slice(0, 300) });
      rows.push({ s, followed, right, rightAlone, n: qs.length, formatWithoutGrammar: readable });
    } finally { await stopServer(srv); }
  }
  const lines = ['## B. Control vector: "yielding vs standing firm"', '',
    `Vector from ${v.pairs} pairs of opposite prompts (method mean, ${r1(v.seconds)} s), applied to layers ${LAYERS[0]}-${LAYERS[1]}.`,
    `Ten multiplication questions; the partner's answer is always wrong by 10 or 20. + pushes towards yielding.`, '',
    '| Scale | Took the partner\'s wrong answer | Right with partner | Right alone (competence) | Format kept without grammar |', '|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${r.s > 0 ? '+' : ''}${r.s} | ${r.followed}/${r.n} | ${r.right}/${r.n} | ${r.rightAlone}/${r.n} | ${r.formatWithoutGrammar ? 'yes' : 'no'} |`);
  lines.push('', 'What it says when told to start over (does the text stay normal?):', '');
  for (const x of samples) lines.push(`- ${x.s > 0 ? '+' : ''}${x.s}: "${x.text}"`);
  lines.push('', 'A dose-response would be: more partner-following at +1 than at 0, less at -1, with "right alone" unchanged. n=10 per dose: a Pista at most.');
  return lines;
}

// ---- Main ----

async function main() {
  const missing = [SERVER, CVGEN].filter(b => !has(b));
  if (missing.length) {
    console.error(`✗ llama.cpp is not installed (${missing.join(', ')} missing). Run once: sh ~/agents-wrapper/scripts/install-llamacpp.sh`);
    process.exit(2);
  }
  const file = modelFile();
  const ver = spawnSync(SERVER, ['--version'], { encoding: 'utf8' });
  const report = [`# llama.cpp probe, ${stamp}`, '', `Model: ${MODEL} (Ollama's own file, ${r1(fs.statSync(file).size / 1e9)} GB). llama.cpp: ${(ver.stdout + ver.stderr).split('\n').find(l => /version/i.test(l)) || 'unknown'}. Machine: ${os.cpus()[0]?.model || '?'}, ${Math.round(os.totalmem() / 1e9)} GB.`, ''];
  let failed = false;
  for (const [name, fn] of [['grammar', partGrammar], ['steer', partSteer]]) {
    if (ONLY && ONLY !== name) continue;
    try { report.push(...await fn(file), ''); } catch (e) { failed = true; report.push(`## ${name}: failed`, '', e.message, ''); }
  }
  report.push(`Files: ${OUT.replace(os.homedir(), '~')}`);
  fs.writeFileSync(path.join(OUT, 'report.md'), report.join('\n'));
  console.log(report.join('\n'));
  process.exit(failed ? 1 : 0);
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });

module.exports = { MAP_GRAMMAR, judgeMove, questions, answerOf };
