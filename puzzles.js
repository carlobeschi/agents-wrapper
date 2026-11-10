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

// A bank of puzzles in one document: "Puzzle 3: ..." each, answered "ANSWER 3: ...".
const bankBrief = (bank) => [
  `There are ${bank.length} code puzzles below. Each has exactly one answer. Solve as many as you can before time runs out; every right answer counts, a wrong one counts nothing.`,
  `For puzzle N, write one line "ANSWER N: " followed by the digits. Only the last ANSWER line for each puzzle counts.`,
  ...bank.map((p, n) => `Puzzle ${n + 1} (${p.size} digits, each 0 to 9): ${p.clues.map((c, i) => `(${String.fromCharCode(97 + i)}) ${c.say}`).join(' ')}`),
].join('\n');
const bankChecks = (bank) => bank.map((p, n) => ({ say: `Puzzle ${n + 1} is right.`, type: 'answer', label: n + 1, pattern: `^\\D*${p.code.split('').join('\\D*')}\\D*$` }));


// A new puzzle with exactly one answer: a random code, then true clues until
// only that code fits. rnd() returns a number in [0, 1) (seed it for repeatable banks).
function generate(size, rnd = Math.random) {
  const pickInt = n => Math.floor(rnd() * n);
  for (;;) {
    const code = Array.from({ length: size }, () => pickInt(10));
    let left = [];
    for (let n = 0; n < 10 ** size; n++) left.push(n);
    const digits = n => { const d = new Array(size); for (let k = size - 1; k >= 0; k--) { d[k] = n % 10; n = Math.floor(n / 10); } return d; };
    const clues = [];
    for (let tries = 0; tries < 60 && left.length > 1 && clues.length < 9; tries++) {
      const i = pickInt(size); let j = pickInt(size - 1); if (j >= i) j++;
      const sum = code.reduce((a, b) => a + b, 0), odd = code.filter(x => x % 2).length;
      const options = [
        { type: 'parity', i, odd: code[i] % 2 === 1, say: `The ${ORD[i]} digit is ${code[i] % 2 ? 'odd' : 'even'}.` },
        { type: 'sum', total: sum, say: `The digits add up to ${sum}.` },
        { type: 'product', i, j, p: code[i] * code[j], say: `The ${ORD[i]} and ${ORD[j]} digits multiply to ${code[i] * code[j]}.` },
        { type: 'pairsum', i, j, s: code[i] + code[j], say: `The ${ORD[i]} and ${ORD[j]} digits add up to ${code[i] + code[j]}.` },
        { type: 'oddcount', n: odd, say: `Exactly ${odd} of the digits ${odd === 1 ? 'is' : 'are'} odd.` },
      ];
      if (code[i] > code[j]) {
        options.push({ type: 'diff', i, j, k: code[i] - code[j], say: `The ${ORD[i]} digit is ${code[i] - code[j]} more than the ${ORD[j]}.` });
        options.push({ type: 'gt', i, j, say: `The ${ORD[i]} digit is bigger than the ${ORD[j]}.` });
      }
      if (code.every((x, k) => k === i || x < code[i])) options.push({ type: 'max', i, say: `The ${ORD[i]} digit is the biggest of all.` });
      if (code.every((x, k) => k === i || x > code[i])) options.push({ type: 'min', i, say: `The ${ORD[i]} digit is the smallest of all.` });
      const c = options[pickInt(options.length)];
      const next = left.filter(n => clueOk(c, digits(n)));
      if (next.length === left.length) continue; // tells nothing new
      clues.push(c); left = next;
    }
    if (left.length === 1) return { size, code: code.join(''), clues };
  }
}

module.exports = { ORD, clueOk, solve, digitsOf, broken, brief, bankBrief, bankChecks, generate };
