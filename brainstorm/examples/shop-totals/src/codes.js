// Discount codes, read once from data/codes.json.
const fs = require('fs');
const path = require('path');
const { toCents } = require('./money');

function loadCodes(file = path.join(__dirname, '..', 'data', 'codes.json')) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const codes = {};
  for (const [name, c] of Object.entries(raw)) {
    // Fixed amounts become cents, like the rest of the shop.
    codes[name] = c.type === 'fixed' ? { ...c, value: toCents(c.value) } : { ...c };
  }
  return codes;
}

module.exports = { loadCodes };
