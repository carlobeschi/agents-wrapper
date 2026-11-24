// Judge for t5. Run by the desk from work/: node --test ../checks/evaluate.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { tokenize } = require(path.join(__dirname, '..', 'work', 'tokenize.js'));
const { parse } = require(path.join(__dirname, '..', 'work', 'parse.js'));
const { evaluate } = require(path.join(__dirname, '..', 'work', 'evaluate.js'));
const cells = { A1: 1, A2: 2, A3: 3, B1: 10 };
const getCell = ref => (ref in cells ? cells[ref] : 0);
const ev = s => evaluate(parse(tokenize(s)), getCell);

test('arithmetic and references; empty cells count as 0', () => {
  assert.strictEqual(ev('1+2*3'), 7);
  assert.strictEqual(ev('-(A1+A2)*B1'), -30);
  assert.strictEqual(ev('C9+1'), 1);
});
test('functions over ranges and single values', () => {
  assert.strictEqual(ev('SUM(A1:A3)'), 6);
  assert.strictEqual(ev('SUM(A1:A3, B1, 4)'), 20);
  assert.strictEqual(ev('AVERAGE(A1:A3)*2'), 4);
  assert.strictEqual(ev('MAX(A1:B1)'), 10);
});
test('errors: division by zero and unknown functions throw with a message naming them', () => {
  assert.throws(() => ev('1/0'), /#DIV\/0!/);
  assert.throws(() => ev('FOO(1)'), /#NAME\?/);
});
