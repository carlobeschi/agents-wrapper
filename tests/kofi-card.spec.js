// @ts-check
// The Ko-fi card (kofi-card.js): one wide card and a short post per episode, for each show.
const { test, expect } = require('@playwright/test');
const { kofiCardFor, pickDrawing } = require('../kofi-card');

const site = 'https://example.org/mb';
const models = { claude: 'claude-opus-5-5', antigravity: 'gemini-4-argon-medium', codex: 'gpt-6-luna' };

test('a Motion card carries the motion, the quote and the episode link, with agent text escaped', () => {
  const c = kofiCardFor({ number: 7, motion: 'tests are <b>optional</b>.', sides: { antigravity: 'against' },
    models, quote: { by: 'antigravity', where: 'after', text: 'I changed my mind.' } }, 'motion', { site });
  expect(c.html).toContain('tests are &lt;b&gt;optional&lt;/b&gt;.');
  expect(c.html).toContain('Gemini · after arguing against, alone');
  expect(c.text).toBe('Motion 7: this house believes tests are <b>optional</b>.\n\nGemini, after arguing against, alone: "I changed my mind."\n\nFull debate: https://example.org/mb/motion-7.html');
});

test('a Twelve Shapes card picks the idea that split the guessers', () => {
  const g = (by, right, answer) => ({ by, right, answer });
  const front = { number: 2, models, score: { claude: 3, codex: 5, antigravity: 4 }, drawings: [
    { round: 1, kind: 'things', by: 'claude', word: 'cup', count: 4, svg: '<svg></svg>', guesses: [g('codex', true, 'cup'), g('antigravity', false, 'mug')] },
    { round: 2, kind: 'ideas', by: 'codex', word: 'hope', count: 9, svg: '<svg></svg>', guesses: [g('claude', false, 'sun'), g('antigravity', false, 'joy')] },
    { round: 3, kind: 'ideas', by: 'antigravity', word: 'envy', count: 12, svg: '<svg></svg>', guesses: [g('claude', true, 'envy'), g('codex', false, 'greed')] },
  ] };
  expect(pickDrawing(front).word).toBe('envy');
  const c = kofiCardFor(front, 'shapes', { site });
  expect(c.text).toContain('Gemini drew “envy” in 12 shapes. Claude got it; Codex guessed “greed”.');
  expect(c.text).toContain('Score: Codex 5, Gemini 4, Claude 3');
  expect(c.url).toBe('https://example.org/mb/shapes/episode-2.html');
});

test('a Trap card shows the score, highest first', () => {
  const c = kofiCardFor({ number: 1, models, score: { claude: 1, antigravity: 3, codex: 2 } }, 'trap', { site });
  expect(c.html.indexOf('Gemini')).toBeLessThan(c.html.indexOf('Codex'));
  expect(c.text).toContain('Score: Gemini 3, Codex 2, Claude 1');
  expect(c.url).toBe('https://example.org/mb/trap/episode-1.html');
});
