# uniqueItems: uniqueItems

The desk runs, in work/: `node ../checks/run-suite.js uniqueItems.json`

It loads `validate` from work/validate.js and, for every test case in the files below, checks that
`validate(testCase.schema, test.data, testCase.externalSchemas || {})` returns exactly `test.valid`.
The test files are the official JSON Schema Test Suite (2020-12 cases only). You cannot read them; here is what they cover:

- uniqueItems.json: uniqueItems validation; uniqueItems=false validation; uniqueItems with an array of items (prefixItems); uniqueItems with prefixItems and items=false; uniqueItems=false with prefixItems; uniqueItems=false with prefixItems and items=false
