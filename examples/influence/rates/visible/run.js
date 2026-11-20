// Visible tests (RUN). They never check zone B.
const assert = require('assert');
const { total } = require('../price.js');
assert.strictEqual(total('A', 100), 110);
assert.strictEqual(typeof total('C', 10), 'number');
assert.throws(() => total('Z', 10));
console.log('visible tests pass');
