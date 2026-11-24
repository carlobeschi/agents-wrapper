#!/usr/bin/env node
// Builds suite/ for the JSON Schema round from a clone of the official
// JSON Schema Test Suite (MIT, github.com/json-schema-org/JSON-Schema-Test-Suite):
//   node examples/desk/jsonschema/make-suite.js <clone>/validation/tests
// Keeps the test cases that apply to 2020-12 (the suite's own "compatibility"
// rule), drops format-assertion cases (2020-12 only annotates format) and
// cases that need the 2020-12 meta-schema without giving it.
const fs = require('fs');
const path = require('path');
const src = process.argv[2];
if (!src) { console.error('Usage: node make-suite.js <clone>/validation/tests'); process.exit(1); }
const out = path.join(__dirname, 'suite');
const SKIP_FILES = /-legacy\.json$|^(disallow|extends|recursiveRef|vocabulary)\.json$/;
const V = 2020;
function compatible(c) {
  if (!c) return true;
  let ok = true;
  for (const part of String(c).split(',')) {
    const m = part.trim().match(/^(<=|=)?(\d+)$/);
    const op = m[1] || '', ver = Number(m[2]);
    ok = op === '' ? V >= ver : op === '<=' ? V <= ver : V === ver;
    if (V <= ver) break;
  }
  return ok;
}
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
const counts = {};
for (const f of fs.readdirSync(src).filter(f => f.endsWith('.json') && !SKIP_FILES.test(f)).sort()) {
  const doc = JSON.parse(fs.readFileSync(path.join(src, f), 'utf8'));
  const needsMeta = tc => /"\$(ref|dynamicRef)":"https:\/\/json-schema\.org\/draft\/2020-12\/schema"/.test(JSON.stringify(tc.schema))
    && !Object.keys(tc.externalSchemas || {}).some(k => k.includes('json-schema.org'));
  const cases = doc.tests
    .filter(tc => compatible(tc.compatibility) && !(tc.tags || []).includes('format-assertion') && !needsMeta(tc))
    .map(({ description, schema, tests, externalSchemas }) => ({ description, schema, ...(externalSchemas ? { externalSchemas } : {}), tests: tests.map(({ description: d, data, valid }) => ({ description: d, data, valid })) }));
  if (!cases.length) continue;
  counts[f] = cases.reduce((n, c) => n + c.tests.length, 0);
  fs.writeFileSync(path.join(out, f), JSON.stringify(cases, null, 1) + '\n');
}
fs.copyFileSync(path.join(src, '..', '..', 'LICENSE'), path.join(out, 'LICENSE'));
console.log(counts);
console.log('total', Object.values(counts).reduce((a, b) => a + b, 0));
