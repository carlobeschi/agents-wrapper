// Applies one discount code to a total in cents. Never below zero.
function applyCode(totalCents, code) {
  if (!code) return totalCents;
  if (code.type === 'percent') return totalCents - Math.round(totalCents * code.value / 100);
  if (code.type === 'fixed') return Math.max(0, totalCents - code.value);
  return totalCents;
}
module.exports = { applyCode };
