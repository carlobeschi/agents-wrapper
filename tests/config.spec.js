// @ts-check
// The shipped configurations are security-sensitive; keep permission and
// environment boundaries covered without invoking any real agent CLI.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { fill, stdinOf, feed } = require('../config');
const { PassThrough } = require('stream');

const ROOT = path.join(__dirname, '..');
const configs = [
  JSON.parse(fs.readFileSync(path.join(ROOT, 'agents.json'), 'utf8')),
  JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/setup/agents.shows.json'), 'utf8')),
];

const agent = (config, id) => config.agents.find(a => a.id === id);

test('shipped headless commands retain explicit permission boundaries', () => {
  for (const config of configs) {
    const claude = agent(config, 'claude');
    expect(claude.headless).toContain('--tools');
    expect(claude.headless).toContain('Read,Glob,Grep');
    expect(claude.headless).toContain('--permission-mode');
    expect(claude.headless).toContain('dontAsk');

    const codex = agent(config, 'codex');
    expect(codex.headless).toContain('--sandbox');
    expect(codex.headless).toContain('read-only');

    const antigravity = agent(config, 'antigravity');
    expect(antigravity.headless).toContain('--sandbox');
    const settingsIndex = antigravity.headless.indexOf('--settings');
    expect(settingsIndex).toBeGreaterThanOrEqual(0);
    const settings = JSON.parse(antigravity.headless[settingsIndex + 1]);
    expect(settings).toMatchObject({
      toolPermission: 'request-review',
      allowNonWorkspaceAccess: false,
      enableTerminalSandbox: true,
    });
    expect(settings.permissions.deny).toEqual([
      'write_file(*)',
      'command(*)',
      'mcp(*)',
      'read_url(*)',
      'execute_url(*)',
      'download_url(*)',
    ]);

    const cursor = agent(config, 'cursor');
    expect(cursor.headless).toContain('--mode');
    expect(cursor.headless).toContain('ask');
    expect(cursor.headless).not.toContain('--force');
    expect(cursor.headless).not.toContain('--yolo');
  }
});

test('shipped headless command templates match the reviewed invocations', () => {
  const expected = {
    claude: ['claude', '-p', '--model', '{model}', '--tools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--', '{prompt}'],
    antigravity: ['agy', '--model', '{model}', '--sandbox', '--settings', '{"toolPermission":"request-review","allowNonWorkspaceAccess":false,"enableTerminalSandbox":true,"permissions":{"deny":["write_file(*)","command(*)","mcp(*)","read_url(*)","execute_url(*)","download_url(*)"]}}', '--disable-slash-commands', '-p', '{prompt}'],
    codex: [
      ['codex', 'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-'],
      ['codex', 'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-m', '{model}', '-'],
    ],
    cursor: ['cursor-agent', '--mode', 'ask', '-p', '{prompt}'],
  };
  for (const config of configs) {
    for (const [id, template] of Object.entries(expected)) {
      const actual = agent(config, id).headless;
      if (id === 'codex') expect(template).toContainEqual(actual);
      else expect(actual, `${id} headless command`).toEqual(template);
    }
  }
});

test('only the configured environment variables reach each shipped CLI', () => {
  const expected = {
    claude: ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR'],
    antigravity: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT'],
    codex: ['OPENAI_API_KEY', 'CODEX_HOME'],
    cursor: ['CURSOR_API_KEY'],
  };
  for (const config of configs) {
    for (const [id, names] of Object.entries(expected)) {
      expect(agent(config, id).env).toEqual(names);
    }
  }
});

test('every configured model is passed to both CLI modes', () => {
  for (const config of configs) {
    for (const entry of config.agents) {
      if (!entry.model) continue;
      for (const mode of ['interactive', 'headless']) {
        const command = entry[mode];
        if (!command) continue;
        const modelFlag = command.findIndex(arg => arg === '--model' || arg === '-m');
        expect(modelFlag, `${entry.id} ${mode} model flag`).toBeGreaterThanOrEqual(0);
        expect(command[modelFlag + 1]).toBe('{model}');
      }
    }
  }
});

test('headless prompts are passed as one argv value or through stdin', async () => {
  const prompt = 'Keep spaces, quotes "and" --flags intact.';
  for (const config of configs) {
    for (const entry of config.agents.filter(agent => Array.isArray(agent.headless))) {
      const args = fill(entry.headless, prompt, entry.model);
      if (entry.stdin) {
        expect(args).not.toContain(prompt);
        expect(stdinOf(entry)).toBe('pipe');
        const child = { stdin: new PassThrough() };
        let received = '';
        child.stdin.on('data', chunk => { received += chunk; });
        const ended = new Promise(resolve => child.stdin.on('end', resolve));
        feed(entry, child, prompt);
        await ended;
        expect(received).toBe(prompt);
        expect(args[args.length - 1]).toBe('-');
      } else {
        expect(args.filter(arg => arg === prompt), `${entry.id} prompt argv`).toHaveLength(1);
        expect(stdinOf(entry)).toBe('ignore');
      }
    }
  }
});
