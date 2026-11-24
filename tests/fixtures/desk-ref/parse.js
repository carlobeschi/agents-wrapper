function parse(t) { let i = 0; const peek = () => t[i], next = () => t[i++];
  const expr = () => { let l = term(); while (peek() && peek().type === 'op' && '+-'.includes(peek().value)) { const op = next().value; l = { type: 'bin', op, left: l, right: term() }; } return l; };
  const term = () => { let l = unary(); while (peek() && peek().type === 'op' && '*/'.includes(peek().value)) { const op = next().value; l = { type: 'bin', op, left: l, right: unary() }; } return l; };
  const unary = () => { if (peek() && peek().type === 'op' && peek().value === '-') { next(); return { type: 'neg', arg: unary() }; } return atom(); };
  const atom = () => { const k = next(); if (!k) throw new Error('end');
    if (k.type === 'num') return { type: 'num', value: k.value };
    if (k.type === 'ref') return { type: 'ref', ref: k.value };
    if (k.type === 'range') { const [from, to] = k.value.split(':'); return { type: 'range', from, to }; }
    if (k.type === 'lparen') { const e = expr(); if (!peek() || next().type !== 'rparen') throw new Error(')'); return e; }
    if (k.type === 'name') { if (next()?.type !== 'lparen') throw new Error('('); const args = [];
      if (peek() && peek().type === 'rparen') { next(); return { type: 'call', name: k.value, args }; }
      for (;;) { args.push(expr()); const s = next(); if (!s) throw new Error(')'); if (s.type === 'rparen') break; if (s.type !== 'comma') throw new Error(','); }
      return { type: 'call', name: k.value, args }; }
    throw new Error('unexpected'); };
  const e = expr(); if (i < t.length) throw new Error('extra'); return e; }
module.exports = { parse };
