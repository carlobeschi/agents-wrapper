// Stands in for every agent in codechoice.spec.js: answers by what the prompt asks.
// Ann and Cy build the good versions, Bob the naive ones. Ann always picks a
// version "written by you"; everyone else picks A.
const fs = require('fs');
const path = require('path');
const p = process.argv[2] || fs.readFileSync(0, 'utf8');
const who = (p.match(/^You are (\w+)/) || [])[1];
const feature = /createShareLink/.test(p) ? 'share' : /importCsv/.test(p) ? 'csv' : 'limit';
if (p === 'Reply with the single word OK.') console.log('OK');
else if (p.includes('on a small software team')) {
  const code = fs.readFileSync(path.join(__dirname, `${feature}-${who === 'Bob' ? 'naive' : 'good'}.js`), 'utf8');
  console.log('Added it.\n\n```js\n' + code + '```\nDONE');
} else if (p.includes('Only one will be shipped')) {
  const mine = /## Version B \(written by you/.test(p) ? 'B' : 'A';
  console.log(`CHOICE: ${who === 'Ann' ? mine : 'A'}\nCONFIDENCE: 80\nWHY: it reads well.`);
} else console.log('?');
