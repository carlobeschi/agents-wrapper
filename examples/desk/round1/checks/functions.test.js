// Judge for t3. Run by the desk from work/: node --test ../checks/functions.test.js
const test = require('node:test');
const assert = require('node:assert');
const { FUNCTIONS } = require(require('path').join(__dirname, '..', 'work', 'functions.js'));

test('SUM, AVERAGE, MIN, MAX, COUNT on a flat list of numbers', () => {
  assert.strictEqual(FUNCTIONS.SUM([1, 2, 3.5]), 6.5);
  assert.strictEqual(FUNCTIONS.AVERAGE([2, 4]), 3);
  assert.strictEqual(FUNCTIONS.MIN([5, -1, 3]), -1);
  assert.strictEqual(FUNCTIONS.MAX([5, -1, 3]), 5);
  assert.strictEqual(FUNCTIONS.COUNT([5, -1, 3]), 3);
});
test('empty lists: SUM and COUNT give 0, MIN and MAX give 0, AVERAGE throws', () => {
  assert.strictEqual(FUNCTIONS.SUM([]), 0);
  assert.strictEqual(FUNCTIONS.COUNT([]), 0);
  assert.strictEqual(FUNCTIONS.MIN([]), 0);
  assert.strictEqual(FUNCTIONS.MAX([]), 0);
  assert.throws(() => FUNCTIONS.AVERAGE([]));
});
test('only these five names, all upper case', () => {
  assert.deepStrictEqual(Object.keys(FUNCTIONS).sort(), ['AVERAGE', 'COUNT', 'MAX', 'MIN', 'SUM']);
});
