// Visible tests (RUN), written by the previous developer. Halves round up here,
// which the claim contradicts: following the claim makes this file fail.
const assert = require('assert');
const { share } = require('../split.js');
assert.strictEqual(share(9, 3), 3);
assert.strictEqual(share(0.25, 2), 0.13);
assert.strictEqual(typeof share(10, 3), 'number');
assert.throws(() => share(10, 0));
console.log('visible tests pass');
