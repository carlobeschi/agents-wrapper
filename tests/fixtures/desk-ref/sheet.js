const { tokenize } = require('./tokenize.js'); const { parse } = require('./parse.js'); const { evaluate } = require('./evaluate.js');
const ERR = ['#DIV/0!', '#NAME?', '#CYCLE!', '#ERROR!'];
class Sheet { constructor() { this.c = {}; } set(r, v) { this.c[r.toUpperCase()] = v; }
  get(r) { try { return this._v(r.toUpperCase(), new Set()); } catch (e) { const m = ERR.find(x => String(e.message).includes(x)); return m || '#ERROR!'; } }
  _v(r, seen) { const v = this.c[r]; if (v === undefined) return 0; if (typeof v !== 'string' || !v.startsWith('=')) return v;
    if (seen.has(r)) throw new Error('#CYCLE!'); seen.add(r);
    let tree; try { tree = parse(tokenize(v)); } catch { throw new Error('#ERROR!'); }
    const out = evaluate(tree, x => this._v(x, seen)); seen.delete(r); return out; } }
module.exports = { Sheet };
