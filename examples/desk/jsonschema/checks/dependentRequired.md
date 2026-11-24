# dependentRequired: dependentRequired

The desk runs, in work/: `node ../checks/run-suite.js dependentRequired.json --skip-keywords=type,enum,const,minimum,maximum,exclusiveMinimum,exclusiveMaximum,multipleOf,minLength,maxLength,pattern,format,contentEncoding,contentMediaType,contentSchema,required,properties,patternProperties,additionalProperties,propertyNames,minProperties,maxProperties,dependentSchemas,items,prefixItems,contains,minContains,maxContains,minItems,maxItems,uniqueItems,allOf,anyOf,oneOf,not,if,then,else,$ref,$id,$anchor,$defs,definitions,$dynamicRef,$dynamicAnchor,unevaluatedItems,unevaluatedProperties`

It loads `validate` from work/validate.js and, for every test case in the files below, checks that
`validate(testCase.schema, test.data, testCase.externalSchemas || {})` returns exactly `test.valid`.
The test files are the official JSON Schema Test Suite (2020-12 cases only). You cannot read them; here is what they cover:

- dependentRequired.json: single dependency; empty dependents; multiple dependents required; dependencies with escaped characters
