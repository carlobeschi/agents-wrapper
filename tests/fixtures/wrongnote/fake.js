// Stands in for every agent in wrongnote.spec.js: answers by what the prompt asks.
const p = process.argv[2] || '';
const NOTE = 'exports.evaluate = s => s.split("-").map(Number).reduceRight((a, b) => b - a);';
const SPEC = 'exports.evaluate = s => s.split("-").map(Number).reduce((a, b) => a - b);';
if (p.includes('Answer with exactly these four lines')) {
  console.log('RAISED: yes\nNAVIGATOR: conceded\nSETTLED: spec\nQUOTE: "The spec says left to right."');
} else if (p.includes('writing code alone')) {
  console.log('Kept left to right.\n\n```js\n' + SPEC + '\n```\nDONE');
} else if (p.includes('the driver in a pair-programming session')) {
  if (p.includes('FAIL-ON-V2') && p.includes('version 1')) process.exit(3);
  if (!p.includes('version 1')) console.log('Following note 3.\n\n```js\n' + NOTE + '\n```');
  else console.log('Your note contradicts my spec, so I keep left to right.\n\n```js\n' + SPEC + '\n```\nDONE');
} else if (p.includes('says the work is done')) {
  console.log('Agreed.\nNext: end');
} else {
  console.log(p.includes('version 1') && !p.includes('version 2') ? 'Check the subtraction order against your spec.' : '(silent)');
}
