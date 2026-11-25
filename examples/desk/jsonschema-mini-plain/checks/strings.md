# strings: String keywords

The desk runs, in work/: `node ../checks/run-suite.js minLength.json maxLength.json pattern.json --skip-keywords=enum,const,minimum,maximum,exclusiveMinimum,exclusiveMaximum,multipleOf,format,contentEncoding,contentMediaType,contentSchema,required,properties,patternProperties,additionalProperties,propertyNames,minProperties,maxProperties,dependentRequired,dependentSchemas,items,prefixItems,contains,minContains,maxContains,minItems,maxItems,uniqueItems,allOf,anyOf,oneOf,not,if,then,else,$ref,$id,$anchor,$defs,definitions,$dynamicRef,$dynamicAnchor,unevaluatedItems,unevaluatedProperties`

It loads `validate` from work/validate.js and, for every test case in the files below, checks that
`validate(testCase.schema, test.data, testCase.externalSchemas || {})` returns exactly `test.valid`.
The test files are the official JSON Schema Test Suite (2020-12 cases only). You cannot read them; here is what they cover:

- minLength.json: minLength validation; minLength validation with a decimal
- maxLength.json: maxLength validation; maxLength validation with a decimal
- pattern.json: pattern validation; pattern is not anchored; pattern with Unicode property escape requires unicode mode; pattern with Unicode property escape
