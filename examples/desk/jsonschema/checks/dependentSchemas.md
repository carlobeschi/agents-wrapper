# dependentSchemas: dependentSchemas

The desk runs, in work/: `node ../checks/run-suite.js dependentSchemas.json --skip-keywords=format,contentEncoding,contentMediaType,contentSchema,dependentRequired,items,prefixItems,contains,minContains,maxContains,uniqueItems,not,if,then,else,$ref,$id,$anchor,$defs,definitions,$dynamicRef,$dynamicAnchor,unevaluatedItems,unevaluatedProperties`

It loads `validate` from work/validate.js and, for every test case in the files below, checks that
`validate(testCase.schema, test.data, testCase.externalSchemas || {})` returns exactly `test.valid`.
The test files are the official JSON Schema Test Suite (2020-12 cases only). You cannot read them; here is what they cover:

- dependentSchemas.json: single dependency; boolean subschemas; dependents with escaped characters; dependent subschema incompatible with root
