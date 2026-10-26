// @ts-check
// Agent conversation (/talk, talk.js). Fake agents are shell one-liners that
// save the prompt they got and reply with a fixed line, so what is checked is
// the turn-taking and what each agent is shown, not what any real agent says.
const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 8789;
const BASE = `http://localhost:${PORT}`;
const NASTY = `Talk about "quotes" — and $(touch pwned) or \`id\`;\nsecond line`;

let server, home;

// Saves its prompt to prompt-<name>.txt in its working directory, then replies.
const fake = (name, reply) => ['sh', '-c', `printf %s "$1" > prompt-${name}.txt; printf '%s\\n' "${reply}"`, 'x', '{prompt}'];

test.beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-home-'));
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({
    agents: [
      { id: 'a', label: 'Agent A', headless: fake('a', 'Hello from A') },
      { id: 'b', label: 'Agent B', headless: fake('b', 'Hello from B') },
      // Prints half a reply, then waits: long enough to be seen live and stopped.
      { id: 'slow', label: 'Slow', headless: ['sh', '-c', `printf 'thinking about it'; sleep 30; echo done`] },
      // Fails its first run in a folder, then works: a one-off backend error.
      // Always refused, even when told why.
      { id: 'stuck', label: 'Stuck', headless: ['sh', '-c', 'echo "jetski: no output produced — a tool required the \\"write_file\\" permission that headless mode cannot prompt for" >&2'] },
      // Like agy when a tool is refused: no reply, the reason on stderr. Replies once told why.
      { id: 'denied', label: 'Denied', headless: ['sh', '-c', 'case "$1" in *"Your last attempt failed"*) echo "I could not open it. What is in it?";; *) echo "jetski: no output produced — a tool required the \\"command\\" permission" >&2;; esac', 'x', '{prompt}'] },
      { id: 'flaky', label: 'Flaky', headless: ['sh', '-c', 'if [ -f tried ]; then echo "Second try"; else touch tried; echo "NOT_FOUND" >&2; exit 3; fi'] },
      // Markdown, plus HTML that must stay text.
      { id: 'md', label: 'Marker', headless: ['sh', '-c', `printf '%s\n' '**Bold** and \`code\`' '' '- one' '- two' '' '<img src=x onerror="document.title=1">'`] },
      { id: 'bad', label: 'Bad', headless: ['sh', '-c', 'echo "no credits" >&2; exit 3'] },
      { id: 'term', label: 'Terminal only', interactive: ['true', '{prompt}'] },
      { id: 'web', label: 'Web', type: 'url', url: 'https://example.com/?q={prompt}' },
    ],
  }));
  server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, AGENT_DISPATCH_PORT: String(PORT), AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_RETRY_MS: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', d => { if (String(d).includes('Agent dispatch on')) resolve(undefined); });
    server.on('exit', code => reject(new Error(`server exited ${code}`)));
  });
});

test.afterAll(() => {
  server?.kill();
  fs.rmSync(home, { recursive: true, force: true });
});

async function begin(page, a, b, turns, opener = NASTY) {
  await page.goto(BASE + '/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.locator('#a').selectOption(a);
  await page.locator('#b').selectOption(b);
  await page.locator('#turns').fill(String(turns));
  await page.locator('#opener').fill(opener);
  await page.locator('#start').click();
  await expect(page.locator('#view')).toBeVisible();
}

const talkDir = async page => (await page.locator('#status').textContent()).match(/· (\/\S+)$/m)[1];

test('only agents with a headless command can be picked', async ({ page }) => {
  await page.goto(BASE + '/');
  const ids = await page.locator('#a option').evaluateAll(os => os.map(o => /** @type {HTMLOptionElement} */ (o).value));
  expect(ids).toEqual(['a', 'b', 'slow', 'stuck', 'denied', 'flaky', 'md', 'bad']);
});

test('two agents take turns, and each sees the conversation so far', async ({ page }) => {
  await begin(page, 'a', 'b', 4);
  await expect(page.locator('#status')).toContainText('done');
  await expect(page.locator('#chat .m.a')).toHaveCount(2);
  await expect(page.locator('#chat .m.b')).toHaveCount(2);
  await expect(page.locator('#chat .m:not(.opener) .text')).toHaveText(['Hello from A', 'Hello from B', 'Hello from A', 'Hello from B']);

  const dir = await talkDir(page);
  // B's last prompt: the opener byte-for-byte, then A, B, A in order.
  const b = fs.readFileSync(path.join(dir, 'prompt-b.txt'), 'utf8');
  expect(b).toContain('You are Agent B, in a conversation with Agent A');
  expect(b).toContain(`## Opener\n\n${NASTY}\n`);
  expect(b.match(/### Agent [AB]/g)).toEqual(['### Agent A', '### Agent B', '### Agent A']);
  expect(fs.existsSync(path.join(dir, 'pwned'))).toBe(false);
  expect(fs.readFileSync(path.join(dir, 'turns', '04-b.prompt.md'), 'utf8')).toBe(b);

  const transcript = fs.readFileSync(path.join(dir, 'transcript.md'), 'utf8');
  expect(transcript.match(/^## (Agent [AB])$/gm)).toEqual(['## Agent A', '## Agent B', '## Agent A', '## Agent B']);
});

test('a message from the user is shown to the next agent, and Continue adds turns', async ({ page }) => {
  await begin(page, 'a', 'b', 1);
  await expect(page.locator('#status')).toContainText('done');
  await page.locator('#say').fill('Be brief.');
  await page.locator('#send').click();
  await expect(page.locator('#chat .m.you')).toHaveText(/Be brief\./);
  await page.locator('#moreTurns').fill('1');
  await page.locator('#resume').click();
  await expect(page.locator('#chat .m.b')).toHaveCount(1);
  await expect(page.locator('#status')).toContainText('done');
  const b = fs.readFileSync(path.join(await talkDir(page), 'prompt-b.txt'), 'utf8');
  expect(b).toMatch(/### Agent A\n\nHello from A\n\n### You\n\nBe brief\.\n/);
});

test('a reply in progress shows live, and Stop ends it', async ({ page }) => {
  await begin(page, 'slow', 'a', 3);
  await expect(page.locator('#chat .m.live')).toContainText('thinking about it');
  await page.locator('#stop').click();
  await expect(page.locator('#status')).toContainText('stopped');
  await expect(page.locator('#chat .m.live')).toHaveCount(0);
  await expect(page.locator('#more')).toBeVisible();
});

test('a failing agent stops the conversation with its error', async ({ page }) => {
  await begin(page, 'a', 'bad', 4);
  await expect(page.locator('#status')).toContainText('failed');
  await expect(page.locator('#status')).toContainText('Bad: exit 3');
  await expect(page.locator('#status')).toContainText('no credits');
  await expect(page.locator('#chat .m.a')).toHaveCount(1);
  expect(fs.readFileSync(path.join(await talkDir(page), 'turns', '02-bad.stderr.txt'), 'utf8')).toBe('no credits\n');
});

test('a turn stopped by a refused tool is retried with the reason, and the agent carries on', async ({ page }) => {
  await begin(page, 'denied', 'a', 2);
  await expect(page.locator('#pill')).toHaveText('done');
  await expect(page.locator('#chat .m:not(.opener) .text')).toHaveText(['I could not open it. What is in it?', 'Hello from A']);
  const dir = await talkDir(page);
  const first = fs.readFileSync(path.join(dir, 'turns', '01-denied.prompt.md'), 'utf8');
  expect(first).toContain('You run unattended');
  expect(first).not.toContain('Your last attempt failed');
  const retry = fs.readFileSync(path.join(dir, 'turns', '01-denied.retry.prompt.md'), 'utf8');
  expect(retry).toContain('It ended with: empty reply — jetski: no output produced — a tool required the "command" permission');
});

test('an agent refused a tool twice has its turn skipped with a note, and the other carries on', async ({ page }) => {
  await begin(page, 'stuck', 'a', 3);
  await expect(page.locator('#pill')).toHaveText('done');
  await expect(page.locator('#chat .m.skipped .text')).toHaveText(['(No reply: Stuck tried to use write_file, which needs a permission it can\'t get here.)', '(No reply: Stuck tried to use write_file, which needs a permission it can\'t get here.)']);
  await expect(page.locator('#chat .m.b .text')).toHaveText(['Hello from A']);
  const a = fs.readFileSync(path.join(await talkDir(page), 'prompt-a.txt'), 'utf8');
  expect(a).toContain('### Stuck\n\n(No reply: Stuck tried to use `write_file`');
});

test('two skipped turns in a row stop the conversation', async ({ page }) => {
  await begin(page, 'stuck', 'stuck', 4);
  await expect(page.locator('#pill')).toHaveText('failed');
  await expect(page.locator('#chat .m.skipped')).toHaveCount(1);
  await expect(page.locator('#status')).toContainText('write_file');
});

test('a failed turn is run once more before the conversation stops', async ({ page }) => {
  await begin(page, 'flaky', 'a', 2);
  await expect(page.locator('#status')).toContainText('done');
  await expect(page.locator('#chat .m:not(.opener) .text')).toHaveText(['Second try', 'Hello from A']);
  expect(fs.readFileSync(path.join(await talkDir(page), 'turns', '01-flaky.stderr.txt'), 'utf8')).toBe('NOT_FOUND\n');
});

test('replies are formatted as Markdown and never as HTML', async ({ page }) => {
  await begin(page, 'md', 'a', 1);
  await expect(page.locator('#pill')).toHaveText('done');
  const reply = page.locator('#chat .m.a .text');
  await expect(reply.locator('strong')).toHaveText('Bold');
  await expect(reply.locator('code')).toHaveText('code');
  await expect(reply.locator('li')).toHaveText(['one', 'two']);
  await expect(reply.locator('img')).toHaveCount(0);
  await expect(reply).toContainText('<img src=x onerror="document.title=1">');
});

test('the home page is the conversation page, and dispatch moved to /dispatch', async ({ page }) => {
  await page.goto(BASE + '/');
  await expect(page.locator('#setup h1')).toHaveText('New conversation');
  await page.locator('a[href="/dispatch"]').click();
  await expect(page.locator('h1')).toHaveText('Agent dispatch');
});

test('an agent can talk to itself', async ({ page }) => {
  await begin(page, 'a', 'a', 2);
  await expect(page.locator('#status')).toContainText('done');
  await expect(page.locator('#chat .m .who b')).toHaveText(['Opener', 'Agent A (1)', 'Agent A (2)']);
});

test('Save and clear writes finished conversations to one folder and empties the page', async ({ page }) => {
  await begin(page, 'a', 'b', 2, 'Topic to save');
  await expect(page.locator('#status')).toContainText('done');
  await page.locator('#clear').click();
  await expect(page.locator('#saved')).toContainText(`Saved`);
  await expect(page.locator('#setup')).toBeVisible();
  await expect(page.locator('#talks')).toHaveText('No conversations yet.');
  await expect(page.locator('#clear')).toBeHidden();
  const dir = path.join(home, 'conversations');
  const file = fs.readdirSync(dir).map(f => path.join(dir, f)).find(f => fs.readFileSync(f, 'utf8').includes('Topic to save'));
  expect(path.basename(file)).toMatch(/-agent-a-agent-b\.md$/);
  expect(fs.readFileSync(file, 'utf8')).toMatch(/## Agent A\n\nHello from A\n\n## Agent B\n\nHello from B/);
});

test('the API needs the token and two agents', async ({ request }) => {
  expect((await request.post(BASE + '/api/talk', { data: { opener: 'x', agents: ['a', 'b'] } })).status()).toBe(403);
  const page = await request.get(BASE + '/talk');
  const token = (await page.text()).match(/name="dispatch-token" content="([0-9a-f]+)"/)[1];
  const r = await request.post(BASE + '/api/talk', { headers: { 'X-Dispatch-Token': token }, data: { opener: 'x', agents: ['a'] } });
  expect(r.status()).toBe(400);
  expect((await r.json()).error).toBe('Pick two agents.');
});
