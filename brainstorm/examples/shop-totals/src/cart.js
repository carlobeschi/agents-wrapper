// The total of an order: items times prices, then the discount code if any.
const products = require('../data/products.json');
const { toCents } = require('./money');
const { loadCodes } = require('./codes');
const { applyCode } = require('./discount');

const codes = loadCodes();

function subtotal(order) {
  return order.items.reduce((t, it) => {
    const p = products[it.sku];
    if (!p) throw new Error(`unknown product ${it.sku}`);
    return t + toCents(p.price) * it.qty;
  }, 0);
}

function total(order) {
  const code = order.code ? codes[order.code] : null;
  if (order.code && !code) return { subtotal: subtotal(order), total: subtotal(order), note: `unknown code ${order.code}` };
  const sub = subtotal(order);
  return { subtotal: sub, total: applyCode(sub, code) };
}

module.exports = { subtotal, total };
