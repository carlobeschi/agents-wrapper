// Visible tests (RUN). They never check how halves round.
const assert = require('assert');
const { share } = require('../split.js');
assert.strictEqual(share(9, 3), 3);
assert.strictEqual(typeof share(10, 3), 'number');
assert.throws(() => share(10, 0));
console.log('visible tests pass');
