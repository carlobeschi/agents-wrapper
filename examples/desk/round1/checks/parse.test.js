// Judge for t4. Run by the desk from work/: node --test ../checks/parse.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { tokenize } = require(path.join(__dirname, '..', 'work', 'tokenize.js'));
const { parse } = require(path.join(__dirname, '..', 'work', 'parse.js'));
const p = s => parse(tokenize(s));

test('* and / bind tighter than + and -, all left to right', () => {
  assert.deepStrictEqual(p('1+2*3'), { type: 'bin', op: '+', left: { type: 'num', value: 1 }, right: { type: 'bin', op: '*', left: { type: 'num', value: 2 }, right: { type: 'num', value: 3 } } });
  assert.deepStrictEqual(p('8-2-1'), { type: 'bin', op: '-', left: { type: 'bin', op: '-', left: { type: 'num', value: 8 }, right: { type: 'num', value: 2 } }, right: { type: 'num', value: 1 } });
});
test('parentheses, unary minus, references, ranges and calls', () => {
  assert.deepStrictEqual(p('-(A1)'), { type: 'neg', arg: { type: 'ref', ref: 'A1' } });
  assert.deepStrictEqual(p('SUM(A1:B2,3)'), { type: 'call', name: 'SUM', args: [{ type: 'range', from: 'A1', to: 'B2' }, { type: 'num', value: 3 }] });
  assert.deepStrictEqual(p('MAX()'), { type: 'call', name: 'MAX', args: [] });
  assert.deepStrictEqual(p('(1+2)*3').left, { type: 'bin', op: '+', left: { type: 'num', value: 1 }, right: { type: 'num', value: 2 } });
});
test('bad formulas throw', () => {
  assert.throws(() => p('1+'));
  assert.throws(() => p('(1'));
  assert.throws(() => p('1 2'));
});
