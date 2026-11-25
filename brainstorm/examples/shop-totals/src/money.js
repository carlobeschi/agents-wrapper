// Amounts are kept in whole cents everywhere, to avoid rounding errors.
const toCents = euros => Math.round(Number(euros) * 100);
const format = cents => `€${(cents / 100).toFixed(2)}`;
module.exports = { toCents, format };
