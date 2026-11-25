const FUNCTIONS = { SUM: a => a.reduce((x, y) => x + y, 0), COUNT: a => a.length, MIN: a => a.length ? Math.min(...a) : 0, MAX: a => a.length ? Math.max(...a) : 0,
  AVERAGE: a => { if (!a.length) throw new Error('#DIV/0!'); return a.reduce((x, y) => x + y, 0) / a.length; } };
module.exports = { FUNCTIONS };
