# propertyCounts: minProperties and maxProperties

The desk runs, in work/: `node ../checks/run-suite.js minProperties.json maxProperties.json`

It loads `validate` from work/validate.js and, for every test case in the files below, checks that
`validate(testCase.schema, test.data, testCase.externalSchemas || {})` returns exactly `test.valid`.
The test files are the official JSON Schema Test Suite (2020-12 cases only). You cannot read them; here is what they cover:

- minProperties.json: minProperties validation; minProperties validation with a decimal
- maxProperties.json: maxProperties validation; maxProperties validation with a decimal; maxProperties = 0 means the object is empty
