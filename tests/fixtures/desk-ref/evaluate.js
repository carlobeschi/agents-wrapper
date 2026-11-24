const { expandRange } = require('./cells.js'); const { FUNCTIONS } = require('./functions.js');
function evaluate(n, get) {
  switch (n.type) {
    case 'num': return n.value; case 'ref': return get(n.ref); case 'neg': return -evaluate(n.arg, get);
    case 'range': throw new Error('#ERROR!');
    case 'bin': { const a = evaluate(n.left, get), b = evaluate(n.right, get);
      if (n.op === '/' && b === 0) throw new Error('#DIV/0!'); return n.op === '+' ? a + b : n.op === '-' ? a - b : n.op === '*' ? a * b : a / b; }
    case 'call': { const f = FUNCTIONS[n.name]; if (!f) throw new Error('#NAME?');
      const vals = n.args.flatMap(a => a.type === 'range' ? expandRange(a.from + ':' + a.to).map(get) : [evaluate(a, get)]); return f(vals); }
  } }
module.exports = { evaluate };
