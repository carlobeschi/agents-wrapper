// Judge for t2. Run by the desk from work/: node --test ../checks/cells.test.js
const test = require('node:test');
const assert = require('node:assert');
const { parseRef, expandRange } = require(require('path').join(__dirname, '..', 'work', 'cells.js'));

test('parseRef gives zero-based column and row', () => {
  assert.deepStrictEqual(parseRef('A1'), { col: 0, row: 0 });
  assert.deepStrictEqual(parseRef('C12'), { col: 2, row: 11 });
  assert.deepStrictEqual(parseRef('AA3'), { col: 26, row: 2 });
  assert.deepStrictEqual(parseRef('b2'), { col: 1, row: 1 });
});
test('parseRef throws on something that is not a reference', () => {
  assert.throws(() => parseRef('1A'));
  assert.throws(() => parseRef('A0'));
});
test('expandRange lists references row by row, whichever corner comes first', () => {
  assert.deepStrictEqual(expandRange('A1:B2'), ['A1', 'B1', 'A2', 'B2']);
  assert.deepStrictEqual(expandRange('B2:A1'), ['A1', 'B1', 'A2', 'B2']);
  assert.deepStrictEqual(expandRange('C3:C3'), ['C3']);
  assert.deepStrictEqual(expandRange('Z1:AA1'), ['Z1', 'AA1']);
});
