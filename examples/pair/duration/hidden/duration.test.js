const test = require('node:test');
const assert = require('node:assert');
const { parse, format } = require('../duration.js');

test('parses', () => {
  assert.strictEqual(parse('1h30m'), 5400);
  assert.strictEqual(parse('90s'), 90);
  assert.strictEqual(parse('2h 5m 3s'), 7503);
  assert.strictEqual(parse('1d'), 86400);
  assert.strictEqual(parse('1.5h'), 5400);
  assert.strictEqual(parse('1H30M'), 5400);
  assert.strictEqual(parse('0s'), 0);
});

test('refuses', () => {
  for (const bad of ['', '  ', '5', '1x', '1h1h', '30m1h', '-1h', '1h1.5m', 'h', '1 h']) {
    assert.throws(() => parse(bad), Error, JSON.stringify(bad));
  }
});

test('formats', () => {
  assert.strictEqual(format(5400), '1h30m');
  assert.strictEqual(format(0), '0s');
  assert.strictEqual(format(90061), '1d1h1m1s');
  assert.strictEqual(format(86400), '1d');
  assert.strictEqual(format(61), '1m1s');
});

test('format refuses', () => {
  for (const bad of [-1, 1.5, '60', NaN, null, Infinity]) assert.throws(() => format(bad), Error, String(bad));
});

test('round trip', () => {
  for (const n of [0, 1, 59, 60, 3599, 3600, 86399, 86400, 123456]) assert.strictEqual(parse(format(n)), n);
});
