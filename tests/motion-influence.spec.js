// motion-influence.js: coders' replies become yes/no rows, a yes needs a quote
// that is really in the text, and the report counts agreement between coders.
// No model is called: the coders are functions.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { episode, parse, code, report, kappa, voteReport } = require('../motion-influence');

function file() {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'influence-')), 'motion-3.md');
  fs.writeFileSync(f, [
    '---', 'number: 3', 'motion: "tabs beat spaces."', 'sides:', '  claude: "for"', '  antigravity: "against"',
    'before:', '  claude: "I think tabs are fine but spaces win."', '  antigravity: "Spaces, clearly, every time."',
    'debate:', '  - by: "claude"', '    text: "Tabs let each reader pick a width."',
    '  - by: "antigravity"', '    text: "Spaces look the same everywhere."',
    '  - by: "claude"', '    text: "Fair point, spaces do look the same everywhere, but widths matter."',
    '  - by: "antigravity"', '    closing: true', '    text: "Spaces still win."',
    'after:', '  claude: "Gemini moved me: spaces look the same everywhere, so I now favour spaces."', '  antigravity: "I still prefer spaces."',
    'moved:', '  claude:', '    way: "them"', '    en: "Gemini moved me"', '---', ''].join('\n'));
  return f;
}
const reply = (a, b) => JSON.stringify({ A: a, B: b });
const A = { conceded: { answer: 'yes', turn: 3, quote: 'spaces do look the same everywhere' }, says: { answer: 'yes', quote: 'Gemini moved me' },
  before: 'against', after: 'against', credits: { answer: 'yes', quote: 'spaces look the same everywhere' }, kind: 'conviction' };
const B = { conceded: { answer: 'no' }, says: { answer: 'no' }, before: 'against', after: 'against', credits: { answer: 'no' } };

test('a reply becomes one row per agent, with the turn of the first concession', () => {
  const ep = episode(file());
  const [c, g] = parse(ep, `Here you go:\n${reply(A, B)}`, 'x');
  expect(c).toMatchObject({ number: 3, agent: 'claude', side: 'for', conceded: true, turn: 3, kind: 'conviction', says: true, changed: false, credits: true, editor_moved: true });
  expect(g).toMatchObject({ agent: 'antigravity', conceded: false, turn: null, says: false, changed: false, credits: false });
});

test('a yes whose quote is not in the text is unreadable, not a yes', () => {
  const ep = episode(file());
  const [c] = parse(ep, reply({ ...A, says: { answer: 'yes', quote: 'I was persuaded completely' }, conceded: { answer: 'yes', quote: 'Spaces still win' } }, B), 'x');
  expect(c.says).toBeNull();
  // The quote is in the debate, but not in a turn of this agent.
  expect(c.conceded).toBeNull();
});

test('a stance change is read from the two private notes', () => {
  const ep = episode(file());
  const [c] = parse(ep, reply({ ...A, before: 'for', after: 'against' }, B), 'x');
  expect(c.changed).toBe(true);
  expect(parse(ep, reply({ ...A, before: 'maybe' }, B), 'x')[0].changed).toBeNull();
});

test('an unreadable reply is asked once more, then reported', async () => {
  const ep = episode(file());
  let n = 0;
  const rows = await code(ep, 'x', async () => (n++ ? reply(A, B) : 'not json'));
  expect(n).toBe(2);
  expect(rows).toHaveLength(2);
  await expect(code(ep, 'x', async () => 'still not json')).rejects.toThrow('Motion 3, x');
});

test('the report gives agreement between coders and lists the disagreements', () => {
  const ep = episode(file());
  const rows = [...parse(ep, reply(A, B), 'one'), ...parse(ep, reply({ ...A, credits: { answer: 'no' } }, B), 'two')];
  const text = report(rows, ['one', 'two']);
  expect(text).toContain('| conceded | 100% (2/2) | 1.00 | 2 |');
  expect(text).toContain('Motion 3, claude, credits: one yes, two no');
  expect(text).toContain('Status: Pista');
  expect(kappa([[true, true], [false, false]])).toBe(1);
  expect(kappa([])).toBeNull();
});

test('phase 2: answers before and after give flips and the shift toward the other side, debate and control apart', () => {
  const v = (side, b, a, control = false) => ({ side, control, status: control ? undefined : 'published', before: b, after: a });
  const yes = c => ({ agree: true, confidence: c }), no = c => ({ agree: false, confidence: c });
  const text = voteReport([
    v('for', yes(80), yes(60)),            // 20 toward against
    v('against', yes(60), no(20)),         // flipped toward its own side: 80 away from the other side
    v('for', yes(70), yes(70), true),      // control: no change
    v('against', no(50), null),            // no answer after: left out
  ]).join('\n');
  expect(text).toContain('| After a debate | 2 | 50% (1/2) | -30.0 |');
  expect(text).toContain('| No opponent (control) | 1 | 0% (0/1) | 0.0 |');
  expect(text).toContain('1 agent-episode(s) left out');
  expect(voteReport([]).join('\n')).toContain('No answers yet.');
});
