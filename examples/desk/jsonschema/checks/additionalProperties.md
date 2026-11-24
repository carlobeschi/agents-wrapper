# additionalProperties: additionalProperties

The desk runs, in work/: `node ../checks/run-suite.js additionalProperties.json`

It loads `validate` from work/validate.js and, for every test case in the files below, checks that
`validate(testCase.schema, test.data, testCase.externalSchemas || {})` returns exactly `test.valid`.
The test files are the official JSON Schema Test Suite (2020-12 cases only). You cannot read them; here is what they cover:

- additionalProperties.json: additionalProperties being false does not allow other properties; non-ASCII pattern with additionalProperties; additionalProperties with schema; additionalProperties can exist by itself; additionalProperties are allowed by default; additionalProperties does not look in applicators; additionalProperties with null valued instance properties; additionalProperties with propertyNames; dependentSchemas with additionalProperties
