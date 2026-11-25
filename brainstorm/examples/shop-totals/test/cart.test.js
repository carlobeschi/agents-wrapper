const test = require('node:test');
const assert = require('node:assert');
const { total } = require('../src/cart');

test('two mugs and socks', () => {
  assert.strictEqual(total({ items: [{ sku: 'mug', qty: 2 }, { sku: 'socks', qty: 1 }] }).total, 3223);
});

test('SAVE10 takes ten percent off', () => {
  assert.strictEqual(total({ items: [{ sku: 'book', qty: 1 }], code: 'SAVE10' }).total, 1791);
});
