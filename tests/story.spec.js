// @ts-check
// Story mode (/story, story.js). Same fake agents as talk.spec.js: they save
// the prompt they got in their working directory and reply with a fixed line,
// a journal line when the prompt sends them home.
const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 8790;
const BASE = `http://localhost:${PORT}`;

let server, home;

const fake = name => ['sh', '-c',
  `printf %s "$1" > prompt-${name}.txt; case "$1" in *"you are home"*) echo "Journal of ${name}";; *) echo "Hello from ${name}";; esac`,
  'x', '{prompt}'];

test.beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'story-home-'));
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({
    agents: [
      { id: 'a', label: 'Agent A', headless: fake('a') },
      { id: 'b', label: 'Agent B', headless: fake('b') },
      { id: 'claude', label: 'Claude Code', headless: fake('claude') },
      { id: 'antigravity', label: 'Antigravity CLI', headless: fake('antigravity') },
      { id: 'slow', label: 'Slow', headless: ['sh', '-c', `printf 'thinking about it'; sleep 30; echo done`] },
      { id: 'bad', label: 'Bad', headless: ['sh', '-c', 'echo "no credits" >&2; exit 3'] },
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

async function begin(page, a, b, days, turns, opener = 'Two old friends meet at a café.') {
  await page.goto(BASE + '/story');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.locator('#a').selectOption(a);
  await page.locator('#b').selectOption(b);
  await page.locator('#days').fill(String(days));
  await page.locator('#turns').fill(String(turns));
  await page.locator('#opener').fill(opener);
  await page.locator('#start').click();
  await expect(page.locator('#view')).toBeVisible();
}

const storyDir = async page => (await page.locator('#status').textContent()).match(/· (\/\S+)$/m)[1];
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

test('they meet, go home and write a journal, and meet again the next day', async ({ page }) => {
  await begin(page, 'a', 'b', 2, 2);
  await expect(page.locator('#pill')).toHaveText('done');
  await expect(page.locator('#chat h2.day')).toHaveText([/^Day 1$/, /^Day 1, evening/, /^Day 2$/, /^Day 2, evening/]);
  await expect(page.locator('#chat .m:not(.opener) .who b')).toHaveText([
    'Agent A', 'Agent B', "Agent A's journal", "Agent B's journal",
    'Agent B', 'Agent A', "Agent A's journal", "Agent B's journal",   // day 2 is opened by the other one
  ]);

  const dir = await storyDir(page);
  // A's last meeting turn (day 2): its own journal, today's turns, nothing of B's journal or of day 1's meeting.
  const meet = read(dir, 'meeting', 'prompt-a.txt');
  expect(meet).toContain('this is day 2');
  expect(meet).toContain('## Your journal\n\n### Evening of day 1\n\nJournal of a\n');
  expect(meet).not.toContain('Journal of b');
  expect(meet.match(/^### Agent [AB]$/gm)).toEqual(['### Agent B']);
  expect(read(dir, 'steps', 'd02-02-a.prompt.md')).toBe(meet);

  // B's last evening: at home, its day-1 journal and today's meeting in full.
  const evening = read(dir, 'homes', 'b', 'prompt-b.txt');
  expect(evening).toContain("Day 2's meeting with Agent A is over and you are home");
  expect(evening).toContain('### Evening of day 1\n\nJournal of b\n');
  expect(evening).not.toContain('Journal of a');
  expect(evening).toMatch(/## Today's meeting\n\n### Agent B\n\nHello from b\n\n### Agent A\n\nHello from a\n/);

  // What each left at home is listed on the page.
  await expect(page.locator('#status')).toContainText('Agent A at home: prompt-a.txt');

  const story = read(dir, 'story.md');
  expect(story.match(/^#+ .+$/gm)).toEqual([
    '# Agent A & Agent B', '## How it started',
    '## Day 1', '### Agent A', '### Agent B', '## Day 1, evening', "### Agent A's journal", "### Agent B's journal",
    '## Day 2', '### Agent B', '### Agent A', '## Day 2, evening', "### Agent A's journal", "### Agent B's journal",
  ]);
});

test('Claude and Antigravity are drawn on stage and beside their turns; other agents keep initials', async ({ page }) => {
  await begin(page, 'claude', 'antigravity', 1, 2);
  await expect(page.locator('#pill')).toHaveText('done');
  await expect(page.locator('#stage .fig')).toHaveCount(2);
  await expect(page.locator('#stage .fig.claude')).toContainText('Claude Code');
  await expect(page.locator('#stage .fig.antigravity')).toContainText('Antigravity CLI');
  await expect(page.locator('#chat .m.a .av.drawn svg').first()).toBeVisible();
  await expect(page.locator('#chat .m.b .av.drawn svg').first()).toBeVisible();

  await begin(page, 'a', 'b', 1, 1);
  await expect(page.locator('#stage .fig.plain')).toHaveCount(2);
  await expect(page.locator('#chat .m.a .av').first()).toHaveText('AA');
});

test('a message sent after the day ends reaches the next meeting, and Another day adds one', async ({ page }) => {
  await begin(page, 'a', 'b', 1, 1);
  await expect(page.locator('#pill')).toHaveText('done');
  await expect(page.locator('#resume')).toHaveText('Another day');
  await page.locator('#say').fill('Talk about the weather.');
  await page.locator('#send').click();
  await expect(page.locator('#chat .m.you')).toContainText('at the next meeting');
  await page.locator('#moreDays').fill('1');
  await page.locator('#resume').click();
  await expect(page.locator('#chat h2.day')).toHaveCount(4);
  await expect(page.locator('#pill')).toHaveText('done');
  const meet = read(await storyDir(page), 'meeting', 'prompt-b.txt');
  expect(meet).toContain('this is day 2');
  expect(meet).toMatch(/## Today so far\n\n### You\n\nTalk about the weather\.\n/);
});

test('a meeting turn in progress shows live, and Stop ends it', async ({ page }) => {
  await begin(page, 'slow', 'a', 2, 2);
  await expect(page.locator('#chat .m.live')).toContainText('thinking about it');
  await expect(page.locator('#progress')).toHaveText('day 1 of 2 · turn 1 of 2');
  await page.locator('#stop').click();
  await expect(page.locator('#pill')).toHaveText('stopped');
  await expect(page.locator('#resume')).toHaveText('Continue');
});

test('a failing agent stops the story with its error, and Retry runs that step again', async ({ page }) => {
  await begin(page, 'a', 'bad', 1, 2);
  await expect(page.locator('#pill')).toHaveText('failed');
  await expect(page.locator('#status')).toContainText('Bad: exit 3');
  await expect(page.locator('#status')).toContainText('no credits');
  await expect(page.locator('#resume')).toHaveText('Retry');
  await expect(page.locator('#chat .m.a')).toHaveCount(1);
});

test('/talk and /story link to each other', async ({ page }) => {
  await page.goto(BASE + '/');
  await page.locator('a[href="/story"]').click();
  await expect(page.locator('#setup h1')).toHaveText('New story');
  await page.locator('a[href="/"]').click();
  await expect(page.locator('#setup h1')).toHaveText('New conversation');
});

test('the story API needs the token and two agents', async ({ request }) => {
  expect((await request.post(BASE + '/api/story', { data: { opener: 'x', agents: ['a', 'b'] } })).status()).toBe(403);
  const page = await request.get(BASE + '/story');
  const token = (await page.text()).match(/name="dispatch-token" content="([0-9a-f]+)"/)[1];
  const r = await request.post(BASE + '/api/story', { headers: { 'X-Dispatch-Token': token }, data: { opener: 'x', agents: ['a'] } });
  expect(r.status()).toBe(400);
  expect((await r.json()).error).toBe('Pick two agents.');
});
