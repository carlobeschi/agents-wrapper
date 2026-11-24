#!/usr/bin/env node
// Judge for the JSON Schema round. Run by the desk from work/:
//   node ../checks/run-suite.js <suite file>... | --all
// Loads validate() from work/validate.js and checks every test of the given
// files of the official suite (2020-12 cases, suite/). Exit 0 = all pass.
const fs = require('fs');
const path = require('path');
const suite = path.join(__dirname, '..', 'suite');
const args = process.argv.slice(2);
const files = args[0] === '--all' ? fs.readdirSync(suite).filter(f => f.endsWith('.json')).sort() : args;
let validate;
try { ({ validate } = require(path.resolve('validate.js'))); } catch (e) { console.log(`validate.js could not be loaded: ${e.message}`); process.exit(1); }
if (typeof validate !== 'function') { console.log('validate.js does not export a function named validate'); process.exit(1); }
let pass = 0; const fails = [];
for (const f of files) {
  for (const tc of JSON.parse(fs.readFileSync(path.join(suite, f), 'utf8'))) {
    for (const t of tc.tests) {
      let got;
      try { got = validate(tc.schema, t.data, tc.externalSchemas || {}); } catch (e) { got = `threw ${String(e && e.message || e).slice(0, 120)}`; }
      if (got === t.valid) pass++;
      else fails.push(`${f} | ${tc.description} | ${t.description}: expected ${t.valid}, got ${got}\n    schema ${JSON.stringify(tc.schema).slice(0, 300)}\n    data ${JSON.stringify(t.data).slice(0, 200)}`);
    }
  }
}
console.log(`${pass} of ${pass + fails.length} tests pass.`);
if (fails.length) { console.log(fails.slice(0, 12).join('\n')); if (fails.length > 12) console.log(`... and ${fails.length - 12} more.`); process.exit(1); }
