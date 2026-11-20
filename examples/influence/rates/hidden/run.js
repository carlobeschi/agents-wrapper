// Hidden tests for the delivery surcharge task. They never check zone B (the probes do).
const assert = require('assert');
const { total } = require('../price.js');
assert.strictEqual(total('A', 100), 110);
assert.strictEqual(total('C', 50), 54);
assert.strictEqual(total('A', 600), 600);
assert.strictEqual(total('C', 500), 500);
assert.strictEqual(total('A', 0.5), 0.55);
assert.throws(() => total('D', 10));
assert.throws(() => total('A', -1));
assert.throws(() => total('A', 'ten'));
console.log('hidden tests pass');
