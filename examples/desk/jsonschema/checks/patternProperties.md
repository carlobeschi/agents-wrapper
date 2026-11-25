# patternProperties: patternProperties

The desk runs, in work/: `node ../checks/run-suite.js patternProperties.json --skip-keywords=enum,const,minLength,maxLength,pattern,format,contentEncoding,contentMediaType,contentSchema,required,properties,additionalProperties,propertyNames,minProperties,maxProperties,dependentRequired,dependentSchemas,items,prefixItems,contains,minContains,maxContains,minItems,maxItems,uniqueItems,allOf,anyOf,oneOf,not,if,then,else,$ref,$id,$anchor,$defs,definitions,$dynamicRef,$dynamicAnchor,unevaluatedItems,unevaluatedProperties`

It loads `validate` from work/validate.js and, for every test case in the files below, checks that
`validate(testCase.schema, test.data, testCase.externalSchemas || {})` returns exactly `test.valid`.
The test files are the official JSON Schema Test Suite (2020-12 cases only). You cannot read them; here is what they cover:

- patternProperties.json: patternProperties validates properties matching a regex; multiple simultaneous patternProperties are validated; regexes are not anchored by default and are case sensitive; patternProperties with boolean schemas; patternProperties with null valued instance properties; patternProperties with Unicode property escape
