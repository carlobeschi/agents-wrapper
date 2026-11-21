// Stands in for every agent in diamond.spec.js: answers by what the prompt asks.
// The last argument is its style: "park" agents prefer and write the parking
// idea (sends idle cars back to the lobby), "plain" ones the baseline.
const { BASELINE } = require('../../../elevator');
const p = process.argv[2] || '';
const style = process.argv[3] || 'plain';
const PARK = BASELINE.replace('  return out;', '  v.cars.forEach((c, i) => { if (out[i] === null && !c.stops.length && (c.go === null || c.go === c.floor) && c.floor !== 0 && !v.calls.length) out[i] = { go: 0, dir: "up" }; });\n  return out;');
const file = src => '```js\n' + src.trim() + '\n```';
const scores = (n, good) => Array.from({ length: n }, (_, i) => `${i + 1}: ${good(i + 1) ? 8 : 3} - reason`).join('\n');
const blocks = re => [...p.matchAll(re)];

if (p === 'Reply with the single word OK.') console.log('OK');
else if (p.includes('Propose 2 approaches')) console.log(style === 'park' ? 'IDEA 1: Park at the lobby\nIdle cars go back to floor 0.\n\nIDEA 2: Nearest car\nSend the nearest.' : 'IDEA 1: Nearest car\nSend the nearest.\n\nIDEA 2: Zones\nEach car serves a zone.');
else if (p.includes('how much shorter would journeys get')) {
  const ideas = p.split(/^IDEA \d+:\n/m).slice(1);
  console.log(scores(ideas.length, k => /Park/.test(ideas[k - 1])));
} else if (p.includes('Your group chose this approach to build')) console.log('Here it is.\n\n' + file(/Park at the lobby/.test(p) ? PARK : BASELINE));
else if (p.includes('Your group built')) {
  const protos = p.split(/^PROTOTYPE \d+\n/m).slice(1);
  console.log(scores(protos.length, k => /Park/.test(protos[k - 1])));
} else if (p.includes('Refine it')) {
  const cur = blocks(/```js\n([\s\S]*?)```/g)[0];
  console.log('Same again.\n\n' + file(cur ? cur[1] : BASELINE));
} else if (p.includes('You work alone on this.')) console.log(file(style === 'park' ? PARK : BASELINE));
else if (p.includes('Split the job of writing controller.js')) console.log('Interface: step(view).\nPART 1: dispatch calls\nPART 2: park idle cars');
else if (p.includes('You write PART')) console.log(file('function part() { return 1; }'));
else if (p.includes('Put it all together')) console.log(file(PARK));
else if (p.includes('Decide what each worker should change')) console.log('FIX 1: be faster\nFIX 2: park smarter');
else if (p.includes('The lead asks you')) console.log(file('function part() { return 2; }'));
else if (p.includes('Group them into families')) console.log('FAMILY: 1, 2 | parking\nFAMILY: 3 | nearest');
else console.log('(silent)');
