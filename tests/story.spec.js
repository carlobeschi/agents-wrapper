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

let server, home, key;

const fake = name => ['sh', '-c',
  `printf %s "$1" > prompt-${name}.txt; case "$1" in *"you are home"*) echo "Journal of ${name}";; *) echo "Hello from ${name}";; esac`,
  'x', '{prompt}'];

test.beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'story-home-'));
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({
    agents: [
      { id: 'a', label: 'Agent A', headless: fake('a') },
      // At home: a journal, then a drawing. The painter's is plain; the vandal's tries to run a script.
      { id: 'painter', label: 'Painter', headless: ['sh', '-c',
        `case "$1" in *"you are home"*) printf '%s\n' 'A good day.' '' '\`\`\`svg' '<svg viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs><circle cx="5" cy="5" r="4" fill="url(#g)"/></svg>' '\`\`\`';; *) echo "Hello from painter";; esac`,
        'x', '{prompt}'] },
      { id: 'vandal', label: 'Vandal', headless: ['sh', '-c',
        `case "$1" in *"you are home"*) printf '%s\n' 'A bad day.' '' '<svg viewBox="0 0 10 10" onload="document.title=1"><script>document.title=2</script><circle cx="5" cy="5" r="4"/></svg>';; *) echo "Hello from vandal";; esac`,
        'x', '{prompt}'] },
      { id: 'b', label: 'Agent B', headless: fake('b') },
      { id: 'slow', label: 'Slow', headless: ['sh', '-c', `printf 'thinking about it'; sleep 30; echo done`] },
      // Always refused, even when told why.
      { id: 'stuck', label: 'Stuck', headless: ['sh', '-c', 'echo "jetski: no output produced — a tool required the \\"write_file\\" permission that headless mode cannot prompt for" >&2'] },
      // Like agy when a tool is refused: no reply, the reason on stderr. Replies once told why.
      { id: 'denied', label: 'Denied', headless: ['sh', '-c', 'case "$1" in *"Your last attempt failed"*) echo "I could not open it.";; *) echo "jetski: no output produced — a tool required the \\"command\\" permission" >&2;; esac', 'x', '{prompt}'] },
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
  key = fs.readFileSync(path.join(home, 'key'), 'utf8');
});

test.afterAll(() => {
  server?.kill();
  fs.rmSync(home, { recursive: true, force: true });
});

async function begin(page, a, b, days, turns, opener = 'Two old friends meet at a café.') {
  await page.goto(BASE + '/story#k=' + key);
  await page.evaluate(() => Object.keys(localStorage).filter(k => k !== 'agents.key').forEach(k => localStorage.removeItem(k)));
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
  expect(meet).toMatch(/## Your journal\n\n### Evening of day 1 · [0-9a-f]{8}\n\nJournal of a\n/);
  expect(meet).not.toContain('Journal of b');
  expect(meet.match(/^### Agent [AB] · [0-9a-f]{8}$/gm)?.map(h => h.slice(0, 11))).toEqual(['### Agent B']);
  expect(read(dir, 'steps', 'd02-02-a.prompt.md')).toBe(meet);

  // B's last evening: at home, its day-1 journal and today's meeting in full.
  const evening = read(dir, 'homes', 'b', 'prompt-b.txt');
  expect(evening).toContain("Day 2's meeting with Agent A is over and you are home");
  expect(evening).toMatch(/### Evening of day 1 · [0-9a-f]{8}\n\nJournal of b\n/);
  expect(evening).not.toContain('Journal of a');
  expect(evening).toMatch(/## Today's meeting\n\n### Agent B · [0-9a-f]{8}\n\nHello from b\n\n### Agent A · [0-9a-f]{8}\n\nHello from a\n/);

  // What each left at home is listed on the page.
  await expect(page.locator('#status')).toContainText('Agent A at home: prompt-a.txt');

  const story = read(dir, 'story.md');
  expect(story.match(/^#+ .+$/gm)).toEqual([
    '# Agent A & Agent B', '## How it started',
    '## Day 1', '### Agent A', '### Agent B', '## Day 1, evening', "### Agent A's journal", "### Agent B's journal",
    '## Day 2', '### Agent B', '### Agent A', '## Day 2, evening', "### Agent A's journal", "### Agent B's journal",
  ]);
});

test('at home each agent can draw the day; the drawing is saved and shown as an image', async ({ page }) => {
  await begin(page, 'painter', 'b', 1, 2);
  await expect(page.locator('#pill')).toHaveText('done');
  const dir = await storyDir(page);
  expect(read(dir, 'homes', 'b', 'prompt-b.txt')).toContain('draw a picture of what the day looked like');

  const journal = page.locator('#chat .m.journal').first();
  await expect(journal.locator('.text p')).toHaveText('A good day.');
  await expect(journal).not.toContainText('svg');
  const img = journal.locator('.drawing img');
  await expect(img).toHaveAttribute('src', /^data:image\/svg\+xml/);
  await expect(img).toHaveJSProperty('naturalWidth', 150);   // it rendered: the namespace was added
  await expect(page.locator('#chat .m.journal').nth(1).locator('.drawing')).toHaveCount(0);   // B wrote no drawing

  const svg = read(dir, 'drawings', 'd01-home-painter.svg');
  expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox/);
  const story = read(dir, 'story.md');
  expect(story).toContain("### Painter's journal\n\nA good day.\n\n![Painter, day 1](drawings/d01-home-painter.svg)\n");
  expect(story).not.toContain('<svg');
});

test('a drawing that could run a script when opened is dropped, and the journal kept', async ({ page }) => {
  await begin(page, 'vandal', 'b', 1, 2);
  await expect(page.locator('#pill')).toHaveText('done');
  const journal = page.locator('#chat .m.journal').first();
  await expect(journal.locator('.text p')).toHaveText('A bad day.');
  await expect(journal.locator('.drawing')).toHaveCount(0);
  expect(await page.title()).toBe('Vandal & Agent B · Agents story');
  const dir = await storyDir(page);
  expect(fs.existsSync(path.join(dir, 'drawings'))).toBe(false);
  expect(read(dir, 'story.md')).not.toMatch(/<svg|!\[Vandal/);
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
  expect(meet).toMatch(/## Today so far\n\n### You · [0-9a-f]{8}\n\nTalk about the weather\.\n/);
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

test('a step stopped by a refused tool is retried with the reason, and the story carries on', async ({ page }) => {
  await begin(page, 'denied', 'b', 1, 2);
  await expect(page.locator('#pill')).toHaveText('done');
  const dir = await storyDir(page);
  expect(read(dir, 'steps', 'd01-01-denied.prompt.md')).toContain('You run unattended');
  expect(read(dir, 'steps', 'd01-01-denied.retry.prompt.md'))
    .toContain('It ended with: empty reply — jetski: no output produced — a tool required the "command" permission');
  await expect(page.locator('#chat .m:not(.opener) .text').first()).toHaveText('I could not open it.');
});

test('a step refused a tool twice is skipped with a note, and the story carries on', async ({ page }) => {
  await begin(page, 'stuck', 'b', 1, 2);
  await expect(page.locator('#pill')).toHaveText('done');
  await expect(page.locator('#chat .m.skipped')).toHaveCount(1);
  await expect(page.locator('#chat .m.journal .text').first()).toContainText('No journal entry: Stuck tried to use write_file');
});

test('/talk and /story link to each other', async ({ page }) => {
  await page.goto(BASE + '/#k=' + key);
  await page.locator('a[href="/story"]').click();
  await expect(page.locator('#setup h1')).toHaveText('New story');
  await page.locator('a[href="/"]').click();
  await expect(page.locator('#setup h1')).toHaveText('New conversation');
});

test('the story API needs the token and two agents', async ({ request }) => {
  expect((await request.post(BASE + '/api/story', { data: { opener: 'x', agents: ['a', 'b'] } })).status()).toBe(403);
  const page = await request.get(BASE + '/story');
  const token = key;
  const r = await request.post(BASE + '/api/story', { headers: { 'X-Dispatch-Token': token }, data: { opener: 'x', agents: ['a'] } });
  expect(r.status()).toBe(400);
  expect((await r.json()).error).toBe('Pick two agents.');
});

test('a file attached to the opener goes to the meeting folder, never to a home', async ({ page }) => {
  await page.goto(BASE + '/story#k=' + key);
  await page.evaluate(() => Object.keys(localStorage).filter(k => k !== 'agents.key').forEach(k => localStorage.removeItem(k)));
  await page.reload();
  await page.locator('#a').selectOption('a');
  await page.locator('#b').selectOption('b');
  await page.locator('#days').fill('1');
  await page.locator('#turns').fill('1');
  await page.locator('#opener').fill('They read a letter.');
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#attachOpener').click();
  await (await chooser).setFiles({ name: 'letter.txt', mimeType: 'text/plain', buffer: Buffer.from('Dear A') });
  await page.locator('#start').click();
  await expect(page.locator('#pill')).toHaveText('done');
  await expect(page.locator('#chat .m.opener .att')).toContainText('files/letter.txt');

  const dir = await storyDir(page);
  expect(fs.readFileSync(path.join(dir, 'meeting', 'files', 'letter.txt'), 'utf8')).toBe('Dear A');
  expect(fs.readFileSync(path.join(dir, 'meeting', 'prompt-a.txt'), 'utf8')).toContain('Attached (in this folder): files/letter.txt');
  const evening = fs.readFileSync(path.join(dir, 'homes', 'a', 'prompt-a.txt'), 'utf8');
  expect(evening).toContain('Attached (at the meeting, not in this folder): files/letter.txt');
  expect(fs.existsSync(path.join(dir, 'homes', 'a', 'files'))).toBe(false);
});
