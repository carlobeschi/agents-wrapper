#!/usr/bin/env node
// Writes goal.json for the JSON Schema round from suite/ (make-suite.js):
//   node examples/desk/jsonschema/make-goal.js
// One task per keyword family, judged by the official tests for it. A task
// "needs" the tasks owning the other keywords its tests use, worked out by
// walking the test schemas, so no task is lent before its tests can pass.
const fs = require('fs');
const path = require('path');
const suite = path.join(__dirname, 'suite');

// task id -> [title, keywords it owns, suite files that judge it]
const TASKS = [
  ['core', 'Core: validate.js and boolean schemas', ['$schema', '$comment', 'default', 'examples', 'title', 'description', 'deprecated', 'readOnly', 'writeOnly'], ['boolean_schema.json']],
  ['type', 'type', ['type'], ['type.json']],
  ['enum', 'enum', ['enum'], ['enum.json']],
  ['const', 'const', ['const'], ['const.json']],
  ['numbers', 'Number keywords', ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'], ['minimum.json', 'maximum.json', 'multipleOf.json']],
  ['strings', 'String keywords', ['minLength', 'maxLength', 'pattern'], ['minLength.json', 'maxLength.json', 'pattern.json']],
  ['format', 'format and content (annotations only)', ['format', 'contentEncoding', 'contentMediaType', 'contentSchema'], null],
  ['required', 'required', ['required'], ['required.json']],
  ['properties', 'properties (and default)', ['properties'], ['properties.json', 'default.json']],
  ['patternProperties', 'patternProperties', ['patternProperties'], ['patternProperties.json']],
  ['additionalProperties', 'additionalProperties', ['additionalProperties'], ['additionalProperties.json']],
  ['propertyNames', 'propertyNames', ['propertyNames'], ['propertyNames.json']],
  ['propertyCounts', 'minProperties and maxProperties', ['minProperties', 'maxProperties'], ['minProperties.json', 'maxProperties.json']],
  ['dependentRequired', 'dependentRequired', ['dependentRequired'], ['dependentRequired.json']],
  ['dependentSchemas', 'dependentSchemas', ['dependentSchemas'], ['dependentSchemas.json']],
  ['items', 'items and prefixItems', ['items', 'prefixItems'], ['items.json']],
  ['contains', 'contains, minContains, maxContains', ['contains', 'minContains', 'maxContains'], ['contains.json']],
  ['itemCounts', 'minItems and maxItems', ['minItems', 'maxItems'], ['minItems.json', 'maxItems.json']],
  ['uniqueItems', 'uniqueItems', ['uniqueItems'], ['uniqueItems.json']],
  ['allOf', 'allOf', ['allOf'], ['allOf.json']],
  ['anyOf', 'anyOf', ['anyOf'], ['anyOf.json']],
  ['oneOf', 'oneOf', ['oneOf'], ['oneOf.json']],
  ['not', 'not', ['not'], ['not.json']],
  ['ifThenElse', 'if, then, else', ['if', 'then', 'else'], ['if-then-else.json']],
  ['ref', '$ref, $id, $anchor, $defs, external schemas', ['$ref', '$id', '$anchor', '$defs', 'definitions'], ['ref.json', 'anchor.json', 'id.json', 'infinite-loop-detection.json']],
  ['dynamicRef', '$dynamicRef and $dynamicAnchor', ['$dynamicRef', '$dynamicAnchor'], ['dynamicRef.json']],
  ['unevaluatedItems', 'unevaluatedItems', ['unevaluatedItems'], ['unevaluatedItems.json']],
  ['unevaluatedProperties', 'unevaluatedProperties', ['unevaluatedProperties'], ['unevaluatedProperties.json']],
];
const files = fs.readdirSync(suite).filter(f => f.endsWith('.json'));
TASKS.find(t => t[0] === 'format')[3] = files.filter(f => f.startsWith('format-') || f === 'content.json');
const owner = {};
for (const [id, , kws] of TASKS) for (const k of kws) owner[k] = id;

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

const unknown = new Set();
const tasks = TASKS.map(([id, title, , judged]) => {
  const used = new Set();
  for (const f of judged) for (const tc of JSON.parse(fs.readFileSync(path.join(suite, f), 'utf8'))) {
    keywords(tc.schema, used);
    Object.values(tc.externalSchemas || {}).forEach(x => keywords(x, used));
  }
  const needs = new Set(['core']);
  for (const k of used) { if (owner[k]) needs.add(owner[k]); else unknown.add(k); }
  needs.delete(id);
  return {
    id, title: `${title}`, owns: TASKS.find(x => x[0] === id)[2],
    detail: `Make validate.js pass the official 2020-12 tests in ${judged.join(', ')}. The keywords this task owns: ${TASKS.find(t => t[0] === id)[2].join(', ')}.`,
    needs: id === 'core' ? [] : [...needs].sort(),
    spec: `checks/${id}.md`,
    check: ['node', '../checks/run-suite.js', ...judged],
  };
});
// A cycle would leave tasks that can never be lent: drop needs that close one.
const byId = Object.fromEntries(tasks.map(t => [t.id, t]));
const reaches = (a, b, seen = new Set()) => a === b || (!seen.has(a) && (seen.add(a), byId[a].needs.some(n => reaches(n, b, seen))));
for (const t of tasks) t.needs = t.needs.filter(n => !reaches(n, t.id));
// Dropping a need leaves test cases the task cannot pass yet (enum's tests use
// properties, properties' tests use additionalProperties, and so on). Each
// task is judged only on the cases whose keywords belong to it or to what it
// (transitively) needs; the other cases wait for "all", which runs everything.
const closure = (id, acc = new Set()) => { if (!acc.has(id)) { acc.add(id); byId[id].needs.forEach(n => closure(n, acc)); } return acc; };
for (const t of tasks) {
  const mine = closure(t.id);
  const skip = Object.entries(owner).filter(([, o]) => !mine.has(o)).map(([k]) => k);
  if (skip.length) t.check.push(`--skip-keywords=${skip.join(',')}`);
}
tasks.push({ id: 'all', title: 'Everything together', detail: 'The whole suite passes at once: fix whatever breaks when all keywords meet.', needs: tasks.map(t => t.id), spec: 'checks/all.md', check: ['node', '../checks/run-suite.js', '--all'] });

fs.mkdirSync(path.join(__dirname, 'checks'), { recursive: true });
for (const t of tasks) {
  const judged = t.check.slice(2).filter(a => !a.startsWith('--'));
  fs.writeFileSync(path.join(__dirname, t.spec), [
    `# ${t.id}: ${t.title}`, '',
    'The desk runs, in work/: `' + t.check.join(' ') + '`', '',
    'It loads `validate` from work/validate.js and, for every test case in the files below, checks that',
    '`validate(testCase.schema, test.data, testCase.externalSchemas || {})` returns exactly `test.valid`.',
    'The test files are the official JSON Schema Test Suite (2020-12 cases only). You cannot read them; here is what they cover:', '',
    ...(judged[0] === '--all' ? ['All files of every other task.'] : judged.map(f => {
      const cases = JSON.parse(fs.readFileSync(path.join(suite, f), 'utf8'));
      return `- ${f}: ${cases.map(c => c.description).join('; ')}`;
    })),
  ].join('\n') + '\n');
}
const goal = {
  goal: 'Write a JSON Schema validator for draft 2020-12 in plain Node.js (CommonJS, no packages). work/validate.js must export validate(schema, data, externalSchemas) returning true or false; externalSchemas maps URIs to schemas that $ref may point to. Every task is judged by the official JSON Schema Test Suite. The official tests are in tests-official/ for reading (a copy: the desk judges with its own). Several workers write in the same folder at once: agree on the structure through the files themselves (for example a README.md in work/ describing how keywords plug in) and do not break what others got accepted.',
  work_files: { 'tests-official': 'suite' },
  settings: { budget_usd: 15, lease_seconds: 1200, max_lease_seconds: 21600, max_attempts: 3, recheck_done: true, final_check: ['node', '../checks/run-suite.js', '--all'] },
  tasks,
};
fs.writeFileSync(path.join(__dirname, 'goal.json'), JSON.stringify(goal, null, 2) + '\n');
console.log(tasks.map(t => `${t.id} <- ${t.needs.join(',')}`).join('\n'));
if (unknown.size) console.log('not owned by any task:', [...unknown].join(', '));
