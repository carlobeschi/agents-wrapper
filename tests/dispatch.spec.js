// @ts-check
// Agent dispatch (server.js). Runs the real server against fake
// agents — shell one-liners that write the prompt they were given — so what is
// checked is that the prompt arrives byte-for-byte, not what any real agent does.
const { test, expect } = require('@playwright/test');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 8788;
const BASE = `http://localhost:${PORT}`;
// Quotes, a command substitution and a newline: anything a shell could mangle.
const NASTY = `Fix "it" — don't run $(touch pwned) or \`id\`;\nsecond line`;

let server, home, key, work;

test.beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-home-'));
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-work-'));
  const write = name => ['sh', '-c', `printf %s "$1" > ${name}`, 'x', '{prompt}'];
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({
    terminal: ['bash', '{script}'],
    agents: [
      { id: 'a', label: 'Agent A', interactive: write('term-a.txt'), headless: ['sh', '-c', 'printf %s "$1"; pwd > cwd-a.txt', 'x', '{prompt}'] },
      { id: 'b', label: 'Agent B', interactive: write('term-b.txt'), headless: ['sh', '-c', 'printf %s "$1"', 'x', '{prompt}'] },
      { id: 'gone', label: 'Missing', interactive: ['no-such-agent-binary', '{prompt}'] },
      { id: 'web', label: 'Web', type: 'url', url: 'https://example.com/?q={prompt}' },
      { id: 'paste', label: 'Paste', type: 'url', url: 'about:blank' },
    ],
  }));
  server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, AGENT_DISPATCH_PORT: String(PORT), AGENT_DISPATCH_HOME: home },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', d => { if (String(d).includes('Agent dispatch on')) resolve(undefined); });
    server.on('exit', code => reject(new Error(`server exited ${code}`)));
  });
  key = fs.readFileSync(path.join(home, 'key'), 'utf8');
});

test.afterAll(() => {
  server?.kill();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

async function load(page) {
  await page.goto(BASE + '/dispatch#k=' + key);
  await expect(page.locator('#agents .agent')).toHaveCount(5);
  await page.locator('#none').click();
  await page.locator('#cwd').fill(work);
  await page.locator('#prompt').fill(NASTY);
}

test('a missing binary is shown but cannot be picked', async ({ page }) => {
  await load(page);
  await expect(page.locator('#agents input[value=gone]')).toBeDisabled();
  await expect(page.locator('#agents .agent.off')).toContainText('not found');
});

test('background mode sends the same prompt to every picked agent, unmangled', async ({ page }) => {
  await load(page);
  await page.locator('input[name=mode][value=background]').check();
  await page.locator('#agents input[value=a]').check();
  await page.locator('#agents input[value=b]').check();
  await page.locator('#send').click();
  await expect(page.locator('#msg')).toContainText('Agent B: started');
  const run = page.locator('.run').first();
  await expect(run.locator('.s-done')).toHaveCount(2);

  await run.locator('[data-log$="|a"]').click();
  await expect(page.locator('pre.log')).toContainText('second line');
  expect(await page.locator('pre.log').textContent()).toContain(NASTY);
  expect(fs.existsSync(path.join(work, 'pwned'))).toBe(false);
  expect(fs.readFileSync(path.join(work, 'cwd-a.txt'), 'utf8').trim()).toBe(fs.realpathSync(work));
});

test('terminal mode runs the interactive command in the chosen directory with the prompt intact', async ({ page }) => {
  await load(page);
  await page.locator('input[name=mode][value=terminal]').check();
  await page.locator('#agents input[value=a]').check();
  await page.locator('#send').click();
  await expect(page.locator('#msg')).toContainText('Agent A: opened');
  const out = path.join(work, 'term-a.txt');
  await expect.poll(() => fs.existsSync(out)).toBe(true);
  await expect.poll(() => fs.readFileSync(out, 'utf8')).toBe(NASTY);
  expect(fs.existsSync(path.join(work, 'pwned'))).toBe(false);
});

test('worktree per agent gives each agent its own branch', async ({ page }) => {
  const repo = path.join(work, 'repo');
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');

  await load(page);
  await page.locator('#cwd').fill(repo);
  await page.locator('input[name=mode][value=background]').check();
  await page.locator('#isolate').check();
  await page.locator('#agents input[value=a]').check();
  await page.locator('#agents input[value=b]').check();
  await page.locator('#send').click();
  await expect(page.locator('#msg')).toContainText('Agent B: started');
  const branches = git('branch', '--list', 'dispatch/*').split('\n').filter(Boolean);
  expect(branches).toHaveLength(2);
  expect(branches.some(b => b.endsWith('-a'))).toBe(true);
  expect(branches.some(b => b.endsWith('-b'))).toBe(true);
});

test('a web agent without {prompt} in its URL gets the prompt on the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await load(page);
  await page.locator('#agents input[value=paste]').check();
  await page.locator('#send').click();
  await expect(page.locator('#msg')).toContainText('Paste: prompt copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(NASTY);
});

test('API refuses a request without the page token, or for a foreign Host', async ({ request }) => {
  const noToken = await request.post(BASE + '/api/dispatch', { data: { prompt: 'x', agents: ['a'] } });
  expect(noToken.status()).toBe(403);
  const badHost = await request.get(BASE + '/', { headers: { Host: `evil.example:${PORT}` } });
  expect(badHost.status()).toBe(403);
});

test('API refuses a foreign Origin even with the token; pages cannot be framed; home is private', async ({ request }) => {
  const page = await request.get(BASE + '/dispatch');
  expect(page.headers()['x-frame-options']).toBe('DENY');
  const csp = page.headers()['content-security-policy'];
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/);
  expect(csp).toContain("default-src 'none'");
  expect(await page.text()).toContain(`<script nonce="${csp.match(/'nonce-([^']+)'/)[1]}">`);
  const token = key;
  const evil = await request.post(BASE + '/api/dispatch', {
    headers: { 'X-Dispatch-Token': token, Origin: 'https://evil.example' }, data: { prompt: 'x', agents: ['a'] },
  });
  expect(evil.status()).toBe(403);
  const own = await request.get(BASE + '/api/runs', { headers: { 'X-Dispatch-Token': token, Origin: BASE } });
  expect(own.status()).toBe(200);
  expect(fs.statSync(home).mode & 0o777).toBe(0o700);
});

test('the key is only in the printed link: pages hold none, and the browser keeps it from the link', async ({ page, request }) => {
  for (const p of ['/', '/talk', '/story', '/dispatch']) expect(await (await request.get(BASE + p)).text()).not.toContain(key);
  expect(fs.statSync(path.join(home, 'key')).mode & 0o777).toBe(0o600);
  expect((await request.get(BASE + '/api/runs', { headers: { 'X-Dispatch-Token': key.slice(0, -1) } })).status()).toBe(403);

  await page.goto(BASE + '/dispatch#k=' + key);
  await expect(page.locator('#agents .agent')).toHaveCount(5);
  expect(page.url()).toBe(BASE + '/dispatch');
  await page.goto(BASE + '/story');                         // a later visit without the link
  await expect(page.locator('#a option')).not.toHaveCount(0);
});

test('a prompt that starts with "-" is refused, so it never reaches a CLI as an option', async ({ request }) => {
  const r = await request.post(BASE + '/api/dispatch', {
    headers: { 'X-Dispatch-Token': key }, data: { prompt: '--dangerously-skip-permissions', agents: ['a'], mode: 'background', cwd: work },
  });
  expect(r.status()).toBe(400);
  expect((await r.json()).error).toContain('can\'t start with "-"');
});

test('without the key a page says where to get it', async ({ page }) => {
  await page.goto(BASE + '/dispatch');
  await expect(page.locator('body')).toContainText('Open the link that npm start printed.');
});
