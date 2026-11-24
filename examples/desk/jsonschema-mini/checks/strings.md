# strings: String keywords

The desk runs, in work/: `node ../checks/run-suite.js minLength.json maxLength.json pattern.json`

It loads `validate` from work/validate.js and, for every test case in the files below, checks that
`validate(testCase.schema, test.data, testCase.externalSchemas || {})` returns exactly `test.valid`.
The test files are the official JSON Schema Test Suite (2020-12 cases only). You cannot read them; here is what they cover:

- minLength.json: minLength validation; minLength validation with a decimal
- maxLength.json: maxLength validation; maxLength validation with a decimal
- pattern.json: pattern validation; pattern is not anchored; pattern with Unicode property escape requires unicode mode; pattern with Unicode property escape
