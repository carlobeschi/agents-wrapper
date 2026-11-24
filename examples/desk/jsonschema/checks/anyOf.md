# anyOf: anyOf

The desk runs, in work/: `node ../checks/run-suite.js anyOf.json`

It loads `validate` from work/validate.js and, for every test case in the files below, checks that
`validate(testCase.schema, test.data, testCase.externalSchemas || {})` returns exactly `test.valid`.
The test files are the official JSON Schema Test Suite (2020-12 cases only). You cannot read them; here is what they cover:

- anyOf.json: anyOf; anyOf with base schema; anyOf with boolean schemas, all true; anyOf with boolean schemas, some true; anyOf with boolean schemas, all false; anyOf complex types; anyOf with one empty schema; nested anyOf, to check validation semantics
