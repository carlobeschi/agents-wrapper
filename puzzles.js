// Code puzzles for study.js: an N-digit code and clues the app can check.
// Each clue is data ({ type, ... , say }), so the app can tell which clues a
// wrong answer breaks, and the tests can prove a puzzle has one answer.

const ORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];

function clueOk(c, d) {
  switch (c.type) {
    case 'sum': return d.reduce((a, b) => a + b, 0) === c.total;
    case 'gt': return d[c.i] > d[c.j];
    case 'diff': return d[c.i] - d[c.j] === c.k;
    case 'parity': return d[c.i] % 2 === (c.odd ? 1 : 0);
    case 'product': return d[c.i] * d[c.j] === c.p;
    case 'oddcount': return d.filter(x => x % 2).length === c.n;
    case 'distinct': return new Set(d).size === d.length;
    case 'max': return d.every((x, k) => k === c.i || x < d[c.i]);
    case 'min': return d.every((x, k) => k === c.i || x > d[c.i]);
    case 'pairsum': return d[c.i] + d[c.j] === c.s;
    case 'div': return (d[c.i] * 10 + d[c.j]) % c.k === 0;
    case 'count': return d.filter(x => x === c.digit).length === c.n;
    default: throw new Error(`unknown clue type "${c.type}"`);
  }
}

// Every code of `size` digits that meets all the clues.
function solve(clues, size) {
  const out = [], d = new Array(size).fill(0);
  for (let n = 0; n < 10 ** size; n++) {
    let x = n;
    for (let k = size - 1; k >= 0; k--) { d[k] = x % 10; x = Math.floor(x / 10); }
    if (clues.every(c => clueOk(c, d))) out.push(d.join(''));
  }
  return out;
}

// Read the digits out of an answer line ("4 9 5 2", "4952", "4-9-5-2").
const digitsOf = (answer, size) => {
  const ds = String(answer || '').replace(/\D/g, '');
  return ds.length === size ? ds.split('').map(Number) : null;
};

// Which clues an answer breaks (all of them if it isn't a code of the right length).
function broken(clues, answer, size) {
  const d = digitsOf(answer, size);
  return d ? clues.filter(c => !clueOk(c, d)) : clues.slice();
}

const brief = (p) => [
  `Find a ${p.size}-digit code (each digit 0 to 9). Every clue below is true, and exactly one code fits them all.`,
  ...p.clues.map((c, i) => `(${String.fromCharCode(97 + i)}) ${c.say}`),
  `Work it out in the document. When you are sure, write one line "ANSWER: " followed by the ${p.size} digits. You cannot change it after you say done.`,
].join(' ');

module.exports = { ORD, clueOk, solve, digitsOf, broken, brief };
