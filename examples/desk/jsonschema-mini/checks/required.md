# required: required

The desk runs, in work/: `node ../checks/run-suite.js required.json`

It loads `validate` from work/validate.js and, for every test case in the files below, checks that
`validate(testCase.schema, test.data, testCase.externalSchemas || {})` returns exactly `test.valid`.
The test files are the official JSON Schema Test Suite (2020-12 cases only). You cannot read them; here is what they cover:

- required.json: required validation; required default validation; required with empty array; required with escaped characters; required properties whose names are Javascript object property names
