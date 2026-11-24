# oneOf: oneOf

The desk runs, in work/: `node ../checks/run-suite.js oneOf.json`

It loads `validate` from work/validate.js and, for every test case in the files below, checks that
`validate(testCase.schema, test.data, testCase.externalSchemas || {})` returns exactly `test.valid`.
The test files are the official JSON Schema Test Suite (2020-12 cases only). You cannot read them; here is what they cover:

- oneOf.json: oneOf; oneOf with base schema; oneOf with boolean schemas, all true; oneOf with boolean schemas, one true; oneOf with boolean schemas, more than one true; oneOf with boolean schemas, all false; oneOf complex types; oneOf with empty schema; oneOf with required; oneOf with missing optional property; nested oneOf, to check validation semantics
