# not: not

The desk runs, in work/: `node ../checks/run-suite.js not.json`

It loads `validate` from work/validate.js and, for every test case in the files below, checks that
`validate(testCase.schema, test.data, testCase.externalSchemas || {})` returns exactly `test.valid`.
The test files are the official JSON Schema Test Suite (2020-12 cases only). You cannot read them; here is what they cover:

- not.json: not; not multiple types; not more complex schema; forbidden property; forbid everything with empty schema; forbid everything with boolean schema true; allow everything with boolean schema false; double negation; collect annotations inside a 'not', even if collection is disabled
