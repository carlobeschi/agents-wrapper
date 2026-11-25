function tokenize(s) {
  s = String(s).trim().replace(/^=/, ''); const out = []; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    let m;
    const rest = s.slice(i);
    if ((m = rest.match(/^[A-Za-z]+[0-9]+:[A-Za-z]+[0-9]+/))) { out.push({ type: 'range', value: m[0].toUpperCase() }); i += m[0].length; continue; }
    if ((m = rest.match(/^[A-Za-z]+[0-9]+/))) { out.push({ type: 'ref', value: m[0].toUpperCase() }); i += m[0].length; continue; }
    if ((m = rest.match(/^[A-Za-z]+/))) { out.push({ type: 'name', value: m[0].toUpperCase() }); i += m[0].length; continue; }
    if ((m = rest.match(/^[0-9]+(\.[0-9]+)?/))) { out.push({ type: 'num', value: Number(m[0]) }); i += m[0].length; continue; }
    if ('+-*/'.includes(c)) out.push({ type: 'op', value: c });
    else if (c === '(') out.push({ type: 'lparen', value: c });
    else if (c === ')') out.push({ type: 'rparen', value: c });
    else if (c === ',') out.push({ type: 'comma', value: c });
    else throw new Error('bad char ' + c);
    i++;
  }
  return out;
}
module.exports = { tokenize };
