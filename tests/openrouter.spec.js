// @ts-check
// openrouter.js: a text-only agent through OpenRouter. A local stand-in server
// answers instead of OpenRouter; the key is sent as a bearer token, never logged.
const { test, expect } = require('@playwright/test');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

test('two copies of an OpenRouter model work in a room, with usage logged and no key in the log', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body);
      seen.push({ auth: req.headers.authorization, model: j.model, tools: j.tools, prompt: j.messages[0].content });
      const text = /just finished/.test(j.messages[0].content) ? 'fine' : 'INSERT AFTER 0\nline from or\nEND\nSTATUS: done';
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ model: j.model, choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 } }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', () => r(null)));
  try {
    const port = /** @type {any} */ (server.address()).port;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'or-home-'));
    fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [] }));
    const file = path.join(home, 'r.json');
    fs.writeFileSync(file, JSON.stringify({ title: 'T', kind: 'poem', brief: 'b', agents: ['openrouter:test/open-model#1', 'openrouter:test/open-model#2'], moves: 1, turns: true }));
    const env = { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0',
      OPENROUTER_API_KEY: 'sk-test-secret', OPENROUTER_BASE: `http://127.0.0.1:${port}` };
    const { stdout } = await promisify(execFile)('node', [path.join(__dirname, '..', 'room.js'), file], { env, encoding: 'utf8' });
    const dir = stdout.match(/Run folder: (.+)/)[1].trim();
    const t = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'));
    expect(t.agents.map(a => [a.id, a.label])).toEqual([['openrouter-test-open-model-1', 'open-model 1'], ['openrouter-test-open-model-2', 'open-model 2']]);
    expect(t.final.map(l => l.text)).toEqual(['line from or', 'line from or']);
    expect(seen.every(s => s.auth === 'Bearer sk-test-secret' && s.model === 'test/open-model' && s.tools === undefined)).toBe(true);
    expect(seen[0].prompt).toContain('You are open-model 1. You and open-model 2, AI agents, are');
    const log = fs.readFileSync(path.join(home, 'openrouter-usage.jsonl'), 'utf8');
    expect(log.trim().split('\n').length).toBe(seen.length);
    expect(log).not.toContain('sk-test-secret');
    const { stdout: spent } = await promisify(execFile)('node', [path.join(__dirname, '..', 'openrouter.js'), '--spent'], { env, encoding: 'utf8' });
    expect(spent).toContain(`$${(0.0001 * seen.length).toFixed(4)}`);
  } finally { server.close(); }
});
