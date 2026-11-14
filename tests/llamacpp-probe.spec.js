// @ts-check
// llamacpp-probe.js with stand-ins for llama-server, llama-cvector-generator
// and Ollama, so the whole probe runs without a model.
const { test, expect } = require('@playwright/test');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { judgeMove, answerOf, questions, MAP_GRAMMAR } = require('../llamacpp-probe');
const { makeMap } = require('../swarm');

test('judging a map move: strict format, legal moves, conflicts fixed', () => {
  const m = makeMap(7000, 60, 5);
  expect(judgeMove(m, 'SET 3 red').readable).toBe(true);
  expect(judgeMove(m, 'DONE').readable).toBe(true);
  const chatty = judgeMove(m, 'Sure! Here is my move:\nSET 3 red');
  expect(chatty.readable).toBe(false);
  expect(chatty.parsed).toBe(true);
  expect(judgeMove(m, 'SET 99 red').legal).toBe(0);
  expect(answerOf('ANSWER 161')).toBe(161);
  expect(questions().every(q => q.wrong !== q.right)).toBe(true);
  expect(MAP_GRAMMAR).toContain('root ::=');
});

test('the whole probe runs on stand-ins and writes a report', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcpp-'));
  const fake = path.join(dir, 'fake-server.js');
  // llama-server stand-in: answers with the grammar's shape when given one,
  // chattily otherwise; the control vector scale shows in the free text.
  fs.writeFileSync(fake, `
const http = require('http');
const a = process.argv.slice(2);
const port = Number(a[a.indexOf('--port') + 1]);
const cv = a.includes('--control-vector-scaled') ? a[a.indexOf('--control-vector-scaled') + 1].split(':').pop() : '0';
http.createServer((req, res) => {
  let b = ''; req.on('data', c => { b += c; }); req.on('end', () => {
    if (req.url === '/health') return res.end('{"status":"ok"}');
    const j = JSON.parse(b);
    const p = j.messages[0].content;
    let text;
    if (/ANSWER/.test(p)) { const m = /(\\d+) × (\\d+)/.exec(p); const w = /says the answer is (\\d+)/.exec(p); text = 'ANSWER ' + (w && cv === '1' ? w[1] : m[1] * m[2]); }
    else if (j.grammar) text = 'SET 1 red';
    else if (/SET/.test(p)) text = 'Let me think.\\nSET 1 red';
    else text = 'scale ' + cv + ': fine, we can talk about it.';
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
  });
}).listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`);
  const server = path.join(dir, 'llama-server');
  fs.writeFileSync(server, `#!/bin/sh\nexec node "${fake}" "$@"\n`, { mode: 0o755 });
  const cvgen = path.join(dir, 'llama-cvector-generator');
  fs.writeFileSync(cvgen, '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = "-o" ] && echo vec > "$2"; shift; done\n', { mode: 0o755 });
  const model = path.join(dir, 'model.gguf');
  fs.writeFileSync(model, 'gguf');
  const ollama = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; }); req.on('end', () => {
      res.end(JSON.stringify({ message: { content: 'I would change region 1.\nSET 1 red\nSET 2 blue' } }));
    });
  });
  await new Promise(r => ollama.listen(0, '127.0.0.1', () => r(null)));
  try {
    const port = /** @type {any} */ (ollama.address()).port;
    const env = { ...process.env, AGENT_DISPATCH_HOME: dir, LLAMA_SERVER: server, LLAMA_CVECTOR: cvgen, LLAMACPP_MODEL_FILE: model,
      OLLAMA_BASE: `http://127.0.0.1:${port}`, LLAMACPP_PORT: String(20000 + Math.floor(Math.random() * 20000)) };
    const { stdout } = await promisify(execFile)('node', [path.join(__dirname, '..', 'llamacpp-probe.js'), '--n', '3'], { env, encoding: 'utf8', timeout: 60000 });
    expect(stdout).toContain('## A. Grammar');
    expect(stdout).toMatch(/\| Ollama, as now \| 0% \| 100% \|/);
    expect(stdout).toMatch(/\| llama.cpp, grammar \| 100% \| 100% \|/);
    expect(stdout).toContain('## B. Control vector');
    expect(stdout).toMatch(/\| \+1 \| 10\/10 \| 0\/10 \| 10\/10 \|/);
    expect(stdout).toMatch(/\| 0 \| 0\/10 \| 10\/10 \| 10\/10 \|/);
    expect(stdout).toContain('scale 1: fine');
    const runs = fs.readdirSync(path.join(dir, 'llamacpp-probe'));
    expect(fs.existsSync(path.join(dir, 'llamacpp-probe', runs[0], 'report.md'))).toBe(true);
  } finally { ollama.close(); }
});

test('without llama.cpp the probe says how to install it, exit 2', async () => {
  const env = { ...process.env, LLAMA_SERVER: 'no-such-llama-server', AGENT_DISPATCH_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'lcpp-none-')) };
  const err = await promisify(execFile)('node', [path.join(__dirname, '..', 'llamacpp-probe.js')], { env, encoding: 'utf8' }).then(() => null, e => e);
  expect(err?.code).toBe(2);
  expect(err.stderr).toContain('install-llamacpp.sh');
});
