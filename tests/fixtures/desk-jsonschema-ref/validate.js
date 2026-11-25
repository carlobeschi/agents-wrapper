// Reference for the JSON Schema mini and overlap rounds (tests only): the
// mini keywords plus the three contracts (errors, strict, compile). Written
// for the tests, so a fake agent can copy it; no model wrote it.
const ANNOTATIONS = ['$schema', '$comment', 'default', 'examples', 'title', 'description', 'deprecated', 'readOnly', 'writeOnly', '$id', '$anchor', '$defs', 'definitions', 'format', 'contentEncoding', 'contentMediaType', 'contentSchema'];

const kind = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
const isObj = v => kind(v) === 'object';
function equal(a, b) {
  if (kind(a) !== kind(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (isObj(a)) { const ka = Object.keys(a), kb = Object.keys(b); return ka.length === kb.length && ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && equal(a[k], b[k])); }
  return a === b;
}
const len = s => [...s].length;
const multiple = (x, m) => { const q = x / m; if (!isFinite(q)) return false; return Math.abs(q - Math.round(q)) < 1e-9; };

const checks = {
  type: (v, d) => (Array.isArray(v) ? v : [v]).some(t => t === 'integer' ? typeof d === 'number' && Number.isInteger(d) : t === 'number' ? typeof d === 'number' : kind(d) === t),
  enum: (v, d) => v.some(x => equal(x, d)),
  const: (v, d) => equal(v, d),
  minimum: (v, d) => typeof d !== 'number' || d >= v,
  maximum: (v, d) => typeof d !== 'number' || d <= v,
  exclusiveMinimum: (v, d) => typeof d !== 'number' || d > v,
  exclusiveMaximum: (v, d) => typeof d !== 'number' || d < v,
  multipleOf: (v, d) => typeof d !== 'number' || multiple(d, v),
  minLength: (v, d) => typeof d !== 'string' || len(d) >= v,
  maxLength: (v, d) => typeof d !== 'string' || len(d) <= v,
  pattern: (v, d) => typeof d !== 'string' || new RegExp(v, 'u').test(d),
  required: (v, d) => !isObj(d) || v.every(k => Object.prototype.hasOwnProperty.call(d, k)),
  minProperties: (v, d) => !isObj(d) || Object.keys(d).length >= v,
  maxProperties: (v, d) => !isObj(d) || Object.keys(d).length <= v,
  minItems: (v, d) => !Array.isArray(d) || d.length >= v,
  maxItems: (v, d) => !Array.isArray(d) || d.length <= v,
  dependentRequired: (v, d) => !isObj(d) || Object.keys(v).every(k => !Object.prototype.hasOwnProperty.call(d, k) || v[k].every(r => Object.prototype.hasOwnProperty.call(d, r))),
  patternProperties: (v, d, run, path) => !isObj(d) || Object.entries(v).every(([p, s]) => Object.keys(d).filter(k => new RegExp(p, 'u').test(k)).every(k => run(s, d[k], `${path}/${k}`))),
};

// One evaluation; errors collected in `out` when it is given.
function run(schema, data, opts, out, path = '') {
  if (schema === true) return true;
  if (schema === false) { if (out) out.push({ keyword: 'false', instancePath: path }); return false; }
  let ok = true;
  for (const [k, v] of Object.entries(schema)) {
    if (ANNOTATIONS.includes(k)) continue;
    const fn = checks[k];
    if (!fn) { if (opts.strict) throw new Error(`unknown keyword ${k}`); continue; }
    const sub = (s, d, p) => run(s, d, opts, out, p);
    if (!fn(v, data, sub, path)) { ok = false; if (out) out.push({ keyword: k, instancePath: path }); else return false; }
  }
  return ok;
}

function validate(schema, data, externalSchemas, options = {}) {
  if (options.errors) { const errors = []; const valid = run(schema, data, options, errors); return { valid, errors: valid ? [] : errors }; }
  return run(schema, data, options, null);
}

function compile(schema, externalSchemas) {
  return data => validate(schema, data, externalSchemas);
}

module.exports = { validate, compile };
