#!/usr/bin/env node
// Judge for the JSON Schema round. Run by the desk from work/:
//   node ../checks/run-suite.js <suite file>... | --all  [--skip-keywords=a,b,...]
// Loads validate() from work/validate.js and checks every test of the given
// files of the official suite (2020-12 cases, suite/). Exit 0 = all pass.
// --skip-keywords leaves out the test cases whose schemas use any of those
// keywords: cases that belong to tasks this one does not need (they are
// judged in "all", or not at all in the mini round).
//
// Contracts (the overlap round): three ways of calling the validator that
// some tasks add and every keyword must then respect.
//   errors  validate(schema, data, ext, {errors: true}) -> {valid, errors: [{keyword, instancePath}]}
//           (keyword "false" for a false schema)
//   strict  validate(schema, data, ext, {strict: true}) throws on an unknown keyword
//   compile compile(schema, ext) -> function(data) giving the same answer as validate
// --contracts         also judge every case in each contract validate.js already offers
// --require=a,b       fail unless validate.js offers these contracts, and judge them
// --only-working      judge a contract only on cases plain validate already gets right
//                     (a contract task is not blamed for keywords nobody wrote yet)
const fs = require('fs');
const path = require('path');
const suite = path.join(__dirname, '..', 'suite');
const args = process.argv.slice(2);
const skipArg = args.find(a => a.startsWith('--skip-keywords='));
const skip = new Set(skipArg ? skipArg.slice(16).split(',').filter(Boolean) : []);
const named = args.filter(a => !a.startsWith('--'));
const files = args.includes('--all') ? fs.readdirSync(suite).filter(f => f.endsWith('.json')).sort() : named;

const SUB_MAP = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'];
const SUB_ONE = ['not', 'if', 'then', 'else', 'contains', 'additionalProperties', 'propertyNames', 'unevaluatedItems', 'unevaluatedProperties', 'items', 'contentSchema'];
const SUB_LIST = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
function keywords(s, acc) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return acc;
  for (const [k, v] of Object.entries(s)) {
    acc.add(k);
    if (SUB_MAP.includes(k) && v && typeof v === 'object') Object.values(v).forEach(x => keywords(x, acc));
    else if (SUB_ONE.includes(k)) keywords(v, acc);
    else if (SUB_LIST.includes(k) && Array.isArray(v)) v.forEach(x => keywords(x, acc));
  }
  return acc;
}
const usesSkipped = tc => {
  if (!skip.size) return false;
  const used = keywords(tc.schema, new Set());
  Object.values(tc.externalSchemas || {}).forEach(x => keywords(x, used));
  return [...used].some(k => skip.has(k));
};

const flag = name => args.includes(name);
const reqArg = args.find(a => a.startsWith('--require='));
const required = reqArg ? reqArg.slice(10).split(',').filter(Boolean) : [];
let mod;
try { mod = require(path.resolve('validate.js')); } catch (e) { console.log(`validate.js could not be loaded: ${e.message}`); process.exit(1); }
const validate = mod && mod.validate;
if (typeof validate !== 'function') { console.log('validate.js does not export a function named validate'); process.exit(1); }

const offers = {
  errors: (() => { try { const r = validate(true, 1, {}, { errors: true }); return !!r && typeof r === 'object' && 'valid' in r; } catch { return false; } })(),
  strict: (() => { try { validate({ 'x-no-such-keyword': 1 }, 1, {}, { strict: true }); return false; } catch { return true; } })(),
  compile: typeof mod.compile === 'function',
};
const missing = required.filter(c => !offers[c]);
if (missing.length) {
  const how = { errors: 'validate(schema, data, ext, {errors: true}) returning {valid, errors}', strict: 'validate(schema, data, ext, {strict: true}) throwing on an unknown keyword', compile: 'an exported compile(schema, ext) returning a function of data' };
  console.log(`validate.js does not offer: ${missing.map(c => how[c]).join('; ')}`);
  process.exit(1);
}
const contracts = [...new Set([...required, ...(flag('--contracts') ? Object.keys(offers).filter(c => offers[c]) : [])])];

const show = v => { try { return JSON.stringify(v).slice(0, 160); } catch { return String(v); } };
function judge(way, tc, t) {
  const ext = tc.externalSchemas || {};
  try {
    if (way === 'plain') { const got = validate(tc.schema, t.data, ext); return got === t.valid ? null : `expected ${t.valid}, got ${show(got)}`; }
    if (way === 'strict') { const got = validate(tc.schema, t.data, ext, { strict: true }); return got === t.valid ? null : `in strict mode expected ${t.valid}, got ${show(got)}`; }
    if (way === 'compile') {
      const fn = mod.compile(tc.schema, ext);
      if (typeof fn !== 'function') return `compile did not return a function`;
      const got = fn(t.data);
      return got === t.valid ? null : `through compile expected ${t.valid}, got ${show(got)}`;
    }
    const r = validate(tc.schema, t.data, ext, { errors: true });
    if (!r || typeof r !== 'object' || r.valid !== t.valid) return `with {errors: true} expected valid ${t.valid}, got ${show(r)}`;
    if (!Array.isArray(r.errors)) return `with {errors: true} errors is not a list: ${show(r)}`;
    if (t.valid && r.errors.length) return `with {errors: true} a valid instance has errors: ${show(r.errors)}`;
    if (!t.valid) {
      const used = keywords(tc.schema, new Set(['false']));
      if (!r.errors.some(e => e && used.has(e.keyword) && typeof e.instancePath === 'string')) return `with {errors: true} no error names a keyword of the schema with an instancePath string: ${show(r.errors)}`;
    }
    return null;
  } catch (e) { return `${way === 'plain' ? '' : `(${way}) `}threw ${String(e && e.message || e).slice(0, 120)}`; }
}

let pass = 0, left = 0, notYet = 0; const fails = [];
for (const f of files) {
  for (const tc of JSON.parse(fs.readFileSync(path.join(suite, f), 'utf8'))) {
    if (usesSkipped(tc)) { left += tc.tests.length; continue; }
    for (const t of tc.tests) {
      const plain = judge('plain', tc, t);
      if (flag('--only-working')) {
        if (plain) { notYet++; continue; }
      } else {
        if (plain) { fails.push(`${f} | ${tc.description} | ${t.description}: ${plain}\n    schema ${JSON.stringify(tc.schema).slice(0, 300)}\n    data ${JSON.stringify(t.data).slice(0, 200)}`); continue; }
      }
      const bad = contracts.map(c => judge(c, tc, t)).find(Boolean);
      if (!bad) pass++;
      else fails.push(`${f} | ${tc.description} | ${t.description}: ${bad}\n    schema ${JSON.stringify(tc.schema).slice(0, 300)}\n    data ${JSON.stringify(t.data).slice(0, 200)}`);
    }
  }
}
const extra = [
  contracts.length ? ` Contracts judged: ${contracts.join(', ')}.` : '',
  notYet ? ` (${notYet} cases plain validate does not get right yet: not judged here.)` : '',
  left ? ` (${left} more use keywords of tasks this one does not need: not judged here.)` : '',
].join('');
console.log(`${pass} of ${pass + fails.length} tests pass.${extra}`);
if (fails.length) { console.log(fails.slice(0, 12).join('\n')); if (fails.length > 12) console.log(`... and ${fails.length - 12} more.`); process.exit(1); }
if (flag('--only-working') && pass === 0) { console.log('No case works yet, so nothing could be judged.'); process.exit(1); }
