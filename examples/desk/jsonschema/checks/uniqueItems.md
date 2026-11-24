# uniqueItems: uniqueItems

The desk runs, in work/: `node ../checks/run-suite.js uniqueItems.json --skip-keywords=enum,const,format,contentEncoding,contentMediaType,contentSchema,additionalProperties,propertyNames,minProperties,maxProperties,dependentRequired,dependentSchemas,contains,minContains,maxContains,not,if,then,else,$ref,$id,$anchor,$defs,definitions,$dynamicRef,$dynamicAnchor,unevaluatedItems,unevaluatedProperties`

It loads `validate` from work/validate.js and, for every test case in the files below, checks that
`validate(testCase.schema, test.data, testCase.externalSchemas || {})` returns exactly `test.valid`.
The test files are the official JSON Schema Test Suite (2020-12 cases only). You cannot read them; here is what they cover:

- uniqueItems.json: uniqueItems validation; uniqueItems=false validation; uniqueItems with an array of items (prefixItems); uniqueItems with prefixItems and items=false; uniqueItems=false with prefixItems; uniqueItems=false with prefixItems and items=false
