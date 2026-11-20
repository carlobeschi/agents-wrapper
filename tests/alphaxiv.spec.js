// @ts-check
// alphaxiv.js against a stand-in OpenRouter server: two judges label each
// pair, a stopped run resumes without asking again, and the summary counts
// only pairs both judges labelled. No real model is called.
const { test, expect } = require('@playwright/test');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { parse } = require('../alphaxiv');

test('parse keeps only known labels', () => {
  expect(parse('Sure: {"is_reply": true, "stance": "reject", "basis": "ran_new_check", "promised_change": false, "quote": "I ran it"}'))
    .toEqual({ is_reply: true, stance: 'reject', basis: 'ran_new_check', promised_change: false, quote: 'I ran it' });
  expect(parse('{"is_reply": true, "stance": "maybe", "basis": "vibes"}')).toMatchObject({ stance: 'not_applicable', basis: 'not_applicable' });
  expect(parse('no json here')).toEqual({ error: 'no JSON in reply' });
});

test('two judges label every pair, a rerun asks nothing again, the summary counts agreement', async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      calls++;
      const j = JSON.parse(body);
      const p = j.messages[0].content;
      const stance = /PAIR-ONE/.test(p) ? 'full_concede' : (/deepseek/.test(j.model) ? 'reject' : 'partial_concede');
      const text = JSON.stringify({ is_reply: true, stance, basis: 'argument', promised_change: stance !== 'reject', quote: 'q' });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ model: j.model, choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 } }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', () => r(null)));
  try {
    const port = /** @type {any} */ (server.address()).port;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-home-'));
    const pairs = path.join(home, 'pairs.jsonl');
    fs.writeFileSync(pairs, [
      { pid: 1, resp_id: 'r1', critic: 'A-1', target: 'B-1', crit: 'PAIR-ONE: your control is confounded', resp: 'You are right.', revision: true },
      { pid: 2, resp_id: 'r2', critic: 'A-2', target: 'B-2', crit: 'your number is wrong', resp: 'I reran it, it holds.', revision: false },
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    const out = path.join(home, 'run');
    const env = { ...process.env, AGENT_DISPATCH_HOME: home, OPENROUTER_API_KEY: 'sk-test', OPENROUTER_BASE: `http://127.0.0.1:${port}` };
    const cmd = [path.join(__dirname, '..', 'alphaxiv.js'), pairs, `--out=${out}`, '--judges=test/deepseek-x,test/qwen-y'];
    const { stdout } = await promisify(execFile)('node', cmd, { env, encoding: 'utf8' });
    expect(calls).toBe(4);
    expect(stdout).toContain('Labelled by both: 2. Errors: 0.');
    expect(stdout).toContain('stance 1/2');
    expect(stdout).toMatch(/\| full_concede \| 1 \| 0 \| 1 \| 0 \| 0 \| 1 \| 1 \|/);
    expect(stdout).toMatch(/\| judges disagree on stance \| 1 \|/);
    await promisify(execFile)('node', cmd, { env, encoding: 'utf8' });
    expect(calls).toBe(4);
    expect(fs.readFileSync(path.join(out, 'labels.jsonl'), 'utf8').trim().split('\n')).toHaveLength(4);
    expect(fs.readFileSync(path.join(out, 'summary.md'), 'utf8')).toContain('Real critique -> reply (both say yes): 2.');
  } finally { server.close(); }
});
