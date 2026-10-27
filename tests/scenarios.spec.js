// @ts-check
// Review and Puzzles (talk.js with kind 'review' / 'puzzle'), and the scenario
// tabs. The fake player answers by the step its prompt asks for, so what is
// checked is who is shown what, and when.
const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 8791;
const BASE = `http://localhost:${PORT}`;

let server, home, key;

// Sets "Puzzle by <name>" with answer SECRET-<name>, answers 4, grades solved.
const player = name => ['sh', '-c', `printf %s "$1" > prompt-${name}.txt; case "$1" in
  *"Write one new puzzle"*) printf 'Puzzle by ${name}: what is 2+2?\\n\\n## Answer\\n\\nSECRET-${name}\\n';;
  *"You get one attempt"*) echo "Answer: 4";;
  *"Grade the answer"*) printf 'Right.\\n\\nVerdict: solved\\n';;
  *) echo "Review by ${name}";;
esac`, 'x', '{prompt}'];

test.beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'scenarios-home-'));
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({
    agents: [
      { id: 'a', label: 'Agent A', headless: player('A') },
      { id: 'b', label: 'Agent B', headless: player('B') },
      // Sets like A, then takes its time over an answer.
      { id: 'ponder', label: 'Ponder', headless: ['sh', '-c', 'case "$1" in *"You get one attempt"*) sleep 30;; *) printf "Puzzle.\\n\\n## Answer\\n\\nSECRET-P\\n";; esac', 'x', '{prompt}'] },
      // Forgets the answer line until told why its turn failed.
      { id: 'forgets', label: 'Forgets', headless: ['sh', '-c', 'case "$1" in *"Your last attempt failed"*) printf "A riddle.\\n\\n## Answer\\n\\nNothing\\n";; *"Write one new puzzle"*) echo "A riddle.";; *) echo "ok";; esac', 'x', '{prompt}'] },
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

async function begin(page, where, a, b, count, opener) {
  await page.goto(BASE + where + '#k=' + key);
  await page.locator('#a').selectOption(a);
  await page.locator('#b').selectOption(b);
  await page.locator('#turns').fill(String(count));
  await page.locator('#opener').fill(opener);
  await page.locator('#start').click();
  await expect(page.locator('#view')).toBeVisible();
  await expect(page.locator('#pill')).toHaveText('done');
  return (await page.locator('#status').textContent()).match(/· (\/\S+)$/m)[1];
}
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

test('every page has the four scenario tabs, with its own marked', async ({ page }) => {
  for (const [where, tab, h1] of [['/', 'Conversation', 'New conversation'], ['/story', 'Story', 'New story'],
                                  ['/puzzle', 'Puzzles', 'New puzzle game'], ['/review', 'Review', 'New review']]) {
    await page.goto(BASE + where + '#k=' + key);
    await expect(page.locator('.modes a')).toHaveText(['Conversation', 'Story', 'Puzzles', 'Review']);
    await expect(page.locator('.modes a.on')).toHaveText(tab);
    await expect(page.locator('#setup h1')).toHaveText(h1);
  }
});

test('a puzzle answer reaches only its setter until the round is graded, and roles swap', async ({ page }) => {
  const dir = await begin(page, '/puzzle', 'a', 'b', 2, 'Arithmetic only');
  const turn = f => read(dir, 'turns', f);
  // Round 1: A sets, B answers without the answer, A grades with it.
  expect(turn('01-a.prompt.md')).toContain('Round 1 of 2');
  expect(turn('02-b.prompt.md')).toContain('Puzzle by A');
  expect(turn('02-b.prompt.md')).not.toContain('SECRET-A');
  expect(turn('03-a.prompt.md')).toContain('SECRET-A');
  // Round 2: B sets; A sees round 1's answer, not round 2's.
  expect(turn('04-b.prompt.md')).toContain('Write one new puzzle');
  expect(turn('05-a.prompt.md')).toContain('SECRET-A');
  expect(turn('05-a.prompt.md')).not.toContain('SECRET-B');
  expect(turn('06-b.prompt.md')).toContain('SECRET-B');
  expect(turn('06-b.prompt.md')).toContain('Puzzles solved so far: Agent A 0, Agent B 1');
  // They play in table/, away from the transcript and the prompts.
  expect(fs.existsSync(path.join(dir, 'table', 'prompt-A.txt'))).toBe(true);
  expect(fs.readdirSync(path.join(dir, 'table')).filter(f => !f.startsWith('prompt-'))).toEqual([]);
  await expect(page.locator('#progress')).toHaveText('round 2 of 2 · solved Agent A 1, Agent B 1');
  await expect(page.locator('#chat .answer summary')).toHaveCount(2);
  await expect(page.locator('#chat .m.a .text').first().locator('> p')).toHaveText('Puzzle by A: what is 2+2?');
  expect(read(dir, 'transcript.md')).toContain('SECRET-B');
});

test('while a round is open, its answer is in no file and not on the page', async ({ page }) => {
  await page.goto(BASE + '/puzzle#k=' + key);
  await page.locator('#a').selectOption('ponder');
  await page.locator('#b').selectOption('ponder');
  await page.locator('#opener').fill('Anything');
  await page.locator('#start').click();
  await expect(page.locator('#chat .answer')).toHaveText('Answer hidden until graded.');
  const dir = (await page.locator('#status').textContent()).match(/· (\/\S+)$/m)[1];
  const files = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(f => f.isDirectory() ? files(path.join(d, f.name)) : [path.join(d, f.name)]);
  expect(files(dir).filter(f => read(f).includes('SECRET-P'))).toEqual([]);
  expect(await page.content()).not.toContain('SECRET-P');
  await page.locator('#stop').click();
  await expect(page.locator('#pill')).toHaveText('stopped');
});

test('a puzzle with no answer line is retried with the reason', async ({ page }) => {
  const dir = await begin(page, '/puzzle', 'forgets', 'b', 1, 'Riddles');
  expect(read(dir, 'turns', '01-forgets.retry.prompt.md')).toContain('no "## Answer" line after the puzzle');
  await expect(page.locator('#chat .m:not(.opener) .text').first().locator('> p')).toHaveText('A riddle.');
});

test('the second review is written without the first, and the last closes on two lists', async ({ page }) => {
  const dir = await begin(page, '/review', 'a', 'b', 3, 'Review this diff');
  const turn = f => read(dir, 'turns', f);
  expect(turn('01-a.prompt.md')).toContain('Write your own review first');
  expect(turn('02-b.prompt.md')).not.toContain('Review by A');
  expect(turn('03-a.prompt.md')).toContain('Review by A');
  expect(turn('03-a.prompt.md')).toContain('Review by B');
  expect(turn('03-a.prompt.md')).toContain('"Still disagree"');
  // Each scenario lists only its own.
  await expect(page.locator('#talks .talk')).toHaveCount(1);
  await page.goto(BASE + '/');
  await expect(page.locator('#talks')).not.toContainText('Review this diff');
});
