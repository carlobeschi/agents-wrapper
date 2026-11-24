# properties: properties (and default)

The desk runs, in work/: `node ../checks/run-suite.js properties.json default.json`

It loads `validate` from work/validate.js and, for every test case in the files below, checks that
`validate(testCase.schema, test.data, testCase.externalSchemas || {})` returns exactly `test.valid`.
The test files are the official JSON Schema Test Suite (2020-12 cases only). You cannot read them; here is what they cover:

- properties.json: object properties validation; properties, patternProperties, additionalProperties interaction; properties with boolean schema; properties with escaped characters; properties with null valued instance properties; properties whose names are Javascript object property names
- default.json: invalid type for default; invalid string value for default; the default keyword does not do anything if the property is missing
