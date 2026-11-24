#!/usr/bin/env node
// Judge for the JSON Schema round. Run by the desk from work/:
//   node ../checks/run-suite.js <suite file>... | --all  [--skip-keywords=a,b,...]
// Loads validate() from work/validate.js and checks every test of the given
// files of the official suite (2020-12 cases, suite/). Exit 0 = all pass.
// --skip-keywords leaves out the test cases whose schemas use any of those
// keywords: cases that belong to tasks this one does not need (they are
// judged in "all", or not at all in the mini round).
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

let validate;
try { ({ validate } = require(path.resolve('validate.js'))); } catch (e) { console.log(`validate.js could not be loaded: ${e.message}`); process.exit(1); }
if (typeof validate !== 'function') { console.log('validate.js does not export a function named validate'); process.exit(1); }
let pass = 0, left = 0; const fails = [];
for (const f of files) {
  for (const tc of JSON.parse(fs.readFileSync(path.join(suite, f), 'utf8'))) {
    if (usesSkipped(tc)) { left += tc.tests.length; continue; }
    for (const t of tc.tests) {
      let got;
      try { got = validate(tc.schema, t.data, tc.externalSchemas || {}); } catch (e) { got = `threw ${String(e && e.message || e).slice(0, 120)}`; }
      if (got === t.valid) pass++;
      else fails.push(`${f} | ${tc.description} | ${t.description}: expected ${t.valid}, got ${got}\n    schema ${JSON.stringify(tc.schema).slice(0, 300)}\n    data ${JSON.stringify(t.data).slice(0, 200)}`);
    }
  }
}
console.log(`${pass} of ${pass + fails.length} tests pass.${left ? ` (${left} more use keywords of tasks this one does not need: not judged here.)` : ''}`);
if (fails.length) { console.log(fails.slice(0, 12).join('\n')); if (fails.length > 12) console.log(`... and ${fails.length - 12} more.`); process.exit(1); }
