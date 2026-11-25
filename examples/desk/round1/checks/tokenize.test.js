// Judge for t1. Run by the desk from work/: node --test ../checks/tokenize.test.js
const test = require('node:test');
const assert = require('node:assert');
const { tokenize } = require(require('path').join(__dirname, '..', 'work', 'tokenize.js'));

test('numbers, references, ranges, operators, names, commas and parentheses', () => {
  assert.deepStrictEqual(tokenize('SUM(A1:B2, 3.5) * -c7'), [
    { type: 'name', value: 'SUM' }, { type: 'lparen', value: '(' }, { type: 'range', value: 'A1:B2' },
    { type: 'comma', value: ',' }, { type: 'num', value: 3.5 }, { type: 'rparen', value: ')' },
    { type: 'op', value: '*' }, { type: 'op', value: '-' }, { type: 'ref', value: 'C7' },
  ]);
});
test('no spaces needed; references are upper-cased; a leading = is ignored', () => {
  assert.deepStrictEqual(tokenize('=a1+12/b10'), [
    { type: 'ref', value: 'A1' }, { type: 'op', value: '+' }, { type: 'num', value: 12 }, { type: 'op', value: '/' }, { type: 'ref', value: 'B10' },
  ]);
});
test('names are upper-cased; empty input gives no tokens', () => {
  assert.deepStrictEqual(tokenize('max()'), [{ type: 'name', value: 'MAX' }, { type: 'lparen', value: '(' }, { type: 'rparen', value: ')' }]);
  assert.deepStrictEqual(tokenize('  '), []);
});
test('an unknown character throws', () => {
  assert.throws(() => tokenize('A1 # 2'));
});
