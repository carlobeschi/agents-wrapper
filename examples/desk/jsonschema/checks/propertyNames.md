# propertyNames: propertyNames

The desk runs, in work/: `node ../checks/run-suite.js propertyNames.json`

It loads `validate` from work/validate.js and, for every test case in the files below, checks that
`validate(testCase.schema, test.data, testCase.externalSchemas || {})` returns exactly `test.valid`.
The test files are the official JSON Schema Test Suite (2020-12 cases only). You cannot read them; here is what they cover:

- propertyNames.json: propertyNames validation; propertyNames validation with pattern; propertyNames with boolean schema true; propertyNames with boolean schema false; propertyNames with const; propertyNames with enum
