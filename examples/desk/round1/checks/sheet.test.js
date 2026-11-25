// Judge for t6. Run by the desk from work/: node --test ../checks/sheet.test.js
const test = require('node:test');
const assert = require('node:assert');
const { Sheet } = require(require('path').join(__dirname, '..', 'work', 'sheet.js'));

test('numbers and formulas; formulas see later changes', () => {
  const s = new Sheet();
  s.set('A1', 2); s.set('A2', 3); s.set('A3', '=SUM(A1:A2)*2');
  assert.strictEqual(s.get('A3'), 10);
  s.set('A1', 5);
  assert.strictEqual(s.get('A3'), 16);
  assert.strictEqual(s.get('Z9'), 0);
});
test('formulas can use other formulas', () => {
  const s = new Sheet();
  s.set('A1', '=B1+1'); s.set('B1', '=C1*2'); s.set('C1', 4);
  assert.strictEqual(s.get('A1'), 9);
});
test('error values come back as strings, and spread to cells that use them', () => {
  const s = new Sheet();
  s.set('A1', '=1/0'); s.set('A2', '=A1+1'); s.set('A3', '=NOPE(1)'); s.set('A4', '=1+');
  assert.strictEqual(s.get('A1'), '#DIV/0!');
  assert.strictEqual(s.get('A2'), '#DIV/0!');
  assert.strictEqual(s.get('A3'), '#NAME?');
  assert.strictEqual(s.get('A4'), '#ERROR!');
});
test('cycles give #CYCLE! on every cell in the cycle, and do not hang', () => {
  const s = new Sheet();
  s.set('A1', '=B1'); s.set('B1', '=A1+1'); s.set('C1', 7);
  assert.strictEqual(s.get('A1'), '#CYCLE!');
  assert.strictEqual(s.get('B1'), '#CYCLE!');
  assert.strictEqual(s.get('C1'), 7);
});
