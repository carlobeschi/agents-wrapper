// @ts-check
// The quote card (card.js): what it says, that agent text stays text, and the
// PNG it draws.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cardFor, renderCard, readEpisode } = require('../card');

const front = {
  season: 1, day: 3, title: 'The locked drawer',
  models: { claude: 'claude-opus-5-5', antigravity: 'gemini-4-argon-medium' },
  // Journal line first, to check the room line still goes on top.
  thread: [
    { from: 'journal', by: 'antigravity', text: 'I let it think the key was lost.' },
    { from: 'meeting', by: 'claude', text: 'We should open it <script>alert(1)</script> together.' },
  ],
};
const names = { claude: 'Claude', antigravity: 'Antigravity' };

test('the card says who said what, room first, with the episode and models', () => {
  const c = cardFor(front, { names, url: 'https://example.org/s1/day-3.html' });
  expect(c.html.indexOf('In the room, Claude said')).toBeLessThan(c.html.indexOf('That night, Antigravity wrote'));
  expect(c.html).toContain('Season 1, day 3 · The locked drawer');
  expect(c.html).toContain('example.org/s1/day-3.html');
  expect(c.html).toContain('Claude: claude-opus-5-5 · Antigravity: gemini-4-argon-medium');
  expect(c.alt).toBe('The Second Room, season 1, day 3: The locked drawer. In the room, Claude said: “We should open it <script>alert(1)</script> together.” That night, Antigravity wrote: “I let it think the key was lost.”');
  expect(c.post).toBe('The Second Room, season 1, day 3: The locked drawer\n\nhttps://example.org/s1/day-3.html');
});

test('agent text on the card is escaped, never markup', () => {
  const { html } = cardFor(front, { names });
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('no card without a two-line teaser', () => {
  expect(() => cardFor({ ...front, thread: [front.thread[0]] }, { names })).toThrow(/two-line teaser/);
});

test('reads the front matter season.js writes', () => {
  const text = ['---', 'season: 1', 'day: 3', 'title: "The locked drawer"', 'date: "2026-10-29"', 'morning: "A drawer."',
    'models:', '  claude: "claude-opus-5-5"', '  antigravity: "gemini-4-argon-medium"',
    'thread:', '  - from: "meeting"', '    by: "claude"', '    text: "We should \\"open\\" it."',
    '  - from: "journal"', '    by: "antigravity"', '    text: "I let it think the key was lost."',
    'meeting:', '  - by: "claude"', '    text: "Hello."', '---', ''].join('\n');
  expect(readEpisode(text)).toEqual({
    season: 1, day: 3, title: 'The locked drawer', models: front.models,
    thread: [{ from: 'meeting', by: 'claude', text: 'We should "open" it.' },
             { from: 'journal', by: 'antigravity', text: 'I let it think the key was lost.' }],
  });
});

test('draws a 1080×1350 PNG', async ({ launchOptions }) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'card-')), 'day-3.png');
  await renderCard(cardFor(front, { names }).html, file, launchOptions);
  const png = fs.readFileSync(file);
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1080, 1350]);
});
