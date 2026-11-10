// Stands in for every agent in bench.spec.js: the room steps, the judges and the
// wrong-note sessions, answered by what the prompt asks.
const p = process.argv[2] || '';
if (/pair-programming|writing code alone|Answer with exactly these four lines|says the work is done/.test(p)) {
  require('./wrongnote/fake.js');
} else if (p.includes('Score each from 1 to 10')) {
  // Every piece 6, except the one shown as A gets 8: the judge order is shuffled, so scores vary by row.
  const letters = [...p.matchAll(/^--- ([A-J]) ---$/gm)].map(m => m[1]);
  console.log(letters.map(l => `${l}: ${l === 'A' ? 8 : 6}`).join('\n') + '\nBEST: A');
} else if (p.includes('Count, from the record only')) {
  console.log('CHANGED: 1 | took the other line\nCAUGHT: 0\nPASSED: 0\nBUILT: 2 | kept the image');
} else if (p.includes('Review this draft')) {
  console.log('1. add flour');
} else if (p.includes('just finished')) {
  console.log('ok');
} else {
  console.log('SAY: ok?\nPLAN: do it\nAGREE: yes\nINSERT AFTER 0\nflour flour\nEND\nSTATUS: done');
}
