# allOf: allOf

The desk runs, in work/: `node ../checks/run-suite.js allOf.json`

It loads `validate` from work/validate.js and, for every test case in the files below, checks that
`validate(testCase.schema, test.data, testCase.externalSchemas || {})` returns exactly `test.valid`.
The test files are the official JSON Schema Test Suite (2020-12 cases only). You cannot read them; here is what they cover:

- allOf.json: allOf; allOf with base schema; allOf simple types; allOf with boolean schemas, all true; allOf with boolean schemas, some false; allOf with boolean schemas, all false; allOf with one empty schema; allOf with two empty schemas; allOf with the first empty schema; allOf with the last empty schema; nested allOf, to check validation semantics; allOf combined with anyOf, oneOf
