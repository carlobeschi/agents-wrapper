function parseRef(r) { const m = String(r).toUpperCase().match(/^([A-Z]+)([1-9][0-9]*)$/); if (!m) throw new Error('bad ref');
  let c = 0; for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64); return { col: c - 1, row: Number(m[2]) - 1 }; }
function colName(c) { let s = ''; c++; while (c > 0) { const r = (c - 1) % 26; s = String.fromCharCode(65 + r) + s; c = Math.floor((c - 1) / 26); } return s; }
function expandRange(range) { const [a, b] = range.split(':').map(parseRef); const out = [];
  for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row); r++) for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c++) out.push(colName(c) + (r + 1)); return out; }
module.exports = { parseRef, expandRange };
