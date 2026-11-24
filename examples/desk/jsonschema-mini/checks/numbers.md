# numbers: Number keywords

The desk runs, in work/: `node ../checks/run-suite.js minimum.json maximum.json multipleOf.json`

It loads `validate` from work/validate.js and, for every test case in the files below, checks that
`validate(testCase.schema, test.data, testCase.externalSchemas || {})` returns exactly `test.valid`.
The test files are the official JSON Schema Test Suite (2020-12 cases only). You cannot read them; here is what they cover:

- minimum.json: minimum validation; minimum validation with signed integer; exclusiveMinimum validation
- maximum.json: maximum validation; maximum validation with unsigned integer; exclusiveMaximum validation
- multipleOf.json: multipleOf int; multipleOf number; multipleOf small number; multipleOf very small number; multipleOf when float division = inf; small multiple of large integer
