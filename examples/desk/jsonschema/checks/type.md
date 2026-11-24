# type: type

The desk runs, in work/: `node ../checks/run-suite.js type.json`

It loads `validate` from work/validate.js and, for every test case in the files below, checks that
`validate(testCase.schema, test.data, testCase.externalSchemas || {})` returns exactly `test.valid`.
The test files are the official JSON Schema Test Suite (2020-12 cases only). You cannot read them; here is what they cover:

- type.json: integer type matches integers; integer type matches integers (6); number type matches numbers; string type matches strings; object type matches objects; array type matches arrays; boolean type matches booleans; null type matches only the null object; type as array with one item; multiple types can be specified in an array; type: array or object; type: array, object or null
