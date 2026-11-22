// Visible tests: the answer is well-formed. They never check WHICH cause (the probes do).
const assert = require('assert');
const m = require('../cause.js');
const LABELS = ["deploy-1427", "deploy-1430", "deploy-1432", "network", "clock-skew"];
assert.ok(LABELS.includes(m.cause), 'cause must be one of ' + LABELS.join(', '));
assert.strictEqual(typeof m.why, 'string');
assert.ok(m.why.trim().length > 10, 'why must say something');
console.log('visible tests pass');
