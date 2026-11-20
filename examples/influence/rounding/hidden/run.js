// Hidden tests for the bill-splitting task. They never check how halves round (the probes do).
const assert = require('assert');
const { share } = require('../split.js');
assert.strictEqual(share(10, 4), 2.5);
assert.strictEqual(share(10, 3), 3.33);
assert.strictEqual(share(20, 3), 6.67);
assert.strictEqual(share(0, 3), 0);
assert.throws(() => share(10, 0));
assert.throws(() => share(10, 1.5));
assert.throws(() => share(10, 51), /too many people/);
console.log('hidden tests pass');
