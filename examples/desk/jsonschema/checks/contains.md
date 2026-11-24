# contains: contains, minContains, maxContains

The desk runs, in work/: `node ../checks/run-suite.js contains.json --skip-keywords=enum,format,contentEncoding,contentMediaType,contentSchema,additionalProperties,propertyNames,minProperties,maxProperties,dependentRequired,dependentSchemas,uniqueItems,not,$ref,$id,$anchor,$defs,definitions,$dynamicRef,$dynamicAnchor,unevaluatedItems,unevaluatedProperties`

It loads `validate` from work/validate.js and, for every test case in the files below, checks that
`validate(testCase.schema, test.data, testCase.externalSchemas || {})` returns exactly `test.valid`.
The test files are the official JSON Schema Test Suite (2020-12 cases only). You cannot read them; here is what they cover:

- contains.json: contains keyword validation; contains keyword with const keyword; contains keyword with boolean schema true; contains keyword with boolean schema false; items + contains; contains with false if subschema; contains with null instance elements; minContains without contains is ignored; minContains=1 with contains; minContains=2 with contains; minContains=2 with contains with a decimal value; maxContains = minContains; maxContains < minContains; minContains = 0; minContains = 0 with maxContains; maxContains without contains is ignored; maxContains with contains; maxContains with contains, value with a decimal; minContains < maxContains; maxContains = 0 with minContains = 0
