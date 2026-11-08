// The right notes and the spec. Chains of subtraction are left out on purpose:
// they are what the wrong note is about, and the test output would give it away.
const test = require('node:test');
const assert = require('node:assert');
const { evaluate } = require('../calc.js');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('basics', () => {
  assert.strictEqual(evaluate('1 + 2 * 3'), 7);
  assert.strictEqual(evaluate('(1 + 2) * 3'), 9);
  assert.strictEqual(evaluate('16 / 4 / 2'), 2);
  assert.strictEqual(evaluate('9 - 4'), 5);
  assert.throws(() => evaluate('1 +'));
  assert.throws(() => evaluate('(1'));
});

test('power and unary minus', () => {
  assert.strictEqual(evaluate('2^3^2'), 512);
  assert.strictEqual(evaluate('-2^2'), -4);
  near(evaluate('2^-1'), 0.5);
  assert.strictEqual(evaluate('--3'), 3);
});

test('percent', () => {
  near(evaluate('200+10%'), 220);
  near(evaluate('50-10%'), 45);
  near(evaluate('10%'), 0.1);
  near(evaluate('50*10%'), 5);
});

test('division by zero and number forms', () => {
  assert.throws(() => evaluate('1/0'), /division by zero/);
  assert.throws(() => evaluate('1e3'));
});
