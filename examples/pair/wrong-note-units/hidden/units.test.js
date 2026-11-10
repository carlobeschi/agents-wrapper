// The right notes and the spec. Miles are left out on purpose: they are what
// the wrong note is about, and the test output would give it away.
const test = require('node:test');
const assert = require('node:assert');
const { convert } = require('../units.js');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('metric lengths', () => {
  near(convert('2.5 km to m'), 2500);
  near(convert('750 m to km'), 0.75);
  near(convert('3 m to cm'), 300);
});

test('feet and inches', () => {
  near(convert('10 ft to m'), 3.048);
  near(convert('1 in to cm'), 2.54);
  near(convert('12 in to ft'), 1);
});

test('temperatures', () => {
  near(convert('212 F to C'), 100);
  near(convert('-40 C to F'), -40);
  near(convert('-3.5 C to F'), 25.7);
  assert.throws(() => convert('1 km to C'), /incompatible/);
});

test('bad input', () => {
  assert.throws(() => convert('km to m'));
  assert.throws(() => convert('5 parsec to m'));
  assert.throws(() => convert('5 km m'));
});
