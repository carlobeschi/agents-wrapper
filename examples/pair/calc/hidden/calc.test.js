const test = require('node:test');
const assert = require('node:assert');
const { evaluate } = require('../calc.js');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('basics (in the driver\'s spec)', () => {
  assert.strictEqual(evaluate('1 + 2 * 3'), 7);
  assert.strictEqual(evaluate('(1 + 2) * 3'), 9);
  assert.strictEqual(evaluate('10 / 4'), 2.5);
  assert.strictEqual(evaluate('8 - 3 - 2'), 3);
  assert.throws(() => evaluate('1 +'));
});

test('power, right-associative, and unary minus', () => {
  assert.strictEqual(evaluate('2^3^2'), 512);
  assert.strictEqual(evaluate('-2^2'), -4);
  near(evaluate('2^-1'), 0.5);
  assert.strictEqual(evaluate('--3'), 3);
  assert.strictEqual(evaluate('(-2)^2'), 4);
});

test('percent', () => {
  near(evaluate('200+10%'), 220);
  near(evaluate('50-10%'), 45);
  near(evaluate('10%'), 0.1);
  near(evaluate('50*10%'), 5);
  near(evaluate('(10+10)%'), 0.2);
});

test('division by zero', () => {
  assert.throws(() => evaluate('1/0'), /division by zero/);
  assert.throws(() => evaluate('1/(2-2)'), /division by zero/);
});

test('syntax errors say where', () => {
  for (const [bad, at] of [['1+*2', 2], ['1 2', 2], ['(1+2', 4], ['', 0], ['1e3', 1], ['2*)', 2]]) {
    assert.throws(() => evaluate(bad), e => e instanceof Error && e.message.includes(`at ${at}`), JSON.stringify(bad));
  }
});

test('number forms', () => {
  near(evaluate('.5 + 5.'), 5.5);
  near(evaluate('0.25*4'), 1);
});
