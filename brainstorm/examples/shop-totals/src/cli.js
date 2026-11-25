const fs = require('fs');
const { total } = require('./cart');
const { format } = require('./money');
const order = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const t = total(order);
console.log(`order ${order.id}: subtotal ${format(t.subtotal)}, charged ${format(t.total)}${t.note ? ` (${t.note})` : ''}`);
