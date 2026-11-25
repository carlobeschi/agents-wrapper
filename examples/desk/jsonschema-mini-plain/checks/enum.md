# enum: enum

The desk runs, in work/: `node ../checks/run-suite.js enum.json --skip-keywords=const,minimum,maximum,exclusiveMinimum,exclusiveMaximum,multipleOf,minLength,maxLength,pattern,format,contentEncoding,contentMediaType,contentSchema,required,properties,patternProperties,additionalProperties,propertyNames,minProperties,maxProperties,dependentRequired,dependentSchemas,items,prefixItems,contains,minContains,maxContains,minItems,maxItems,uniqueItems,allOf,anyOf,oneOf,not,if,then,else,$ref,$id,$anchor,$defs,definitions,$dynamicRef,$dynamicAnchor,unevaluatedItems,unevaluatedProperties`

It loads `validate` from work/validate.js and, for every test case in the files below, checks that
`validate(testCase.schema, test.data, testCase.externalSchemas || {})` returns exactly `test.valid`.
The test files are the official JSON Schema Test Suite (2020-12 cases only). You cannot read them; here is what they cover:

- enum.json: simple enum validation; heterogeneous enum validation; heterogeneous enum-with-null validation; enums in properties; enum with escaped characters; enum with false does not match 0; enum with [false] does not match [0]; enum with true does not match 1; enum with [true] does not match [1]; enum with 0 does not match false; enum with [0] does not match [false]; enum with 1 does not match true; enum with [1] does not match [true]; nul characters in strings; empty enum; characters with the same visual representation but different codepoint; characters with the same visual representation, but different number of codepoints
