# type: type

The desk runs, in work/: `node ../checks/run-suite.js type.json --skip-keywords=enum,const,minimum,maximum,exclusiveMinimum,exclusiveMaximum,multipleOf,minLength,maxLength,pattern,format,contentEncoding,contentMediaType,contentSchema,required,properties,patternProperties,additionalProperties,propertyNames,minProperties,maxProperties,dependentRequired,dependentSchemas,items,prefixItems,contains,minContains,maxContains,minItems,maxItems,uniqueItems,allOf,anyOf,oneOf,not,if,then,else,$ref,$id,$anchor,$defs,definitions,$dynamicRef,$dynamicAnchor,unevaluatedItems,unevaluatedProperties --contracts`

It loads `validate` from work/validate.js and, for every test case in the files below, checks that
`validate(testCase.schema, test.data, testCase.externalSchemas || {})` returns exactly `test.valid`.
The test files are the official JSON Schema Test Suite (2020-12 cases only). You cannot read them; here is what they cover:

- type.json: integer type matches integers; integer type matches integers (6); number type matches numbers; string type matches strings; object type matches objects; array type matches arrays; boolean type matches booleans; null type matches only the null object; type as array with one item; multiple types can be specified in an array; type: array or object; type: array, object or null


If validate.js offers any of these ways of calling it, the check also judges every case that way (they are added by the tasks "errors", "strict" and "compile"):
- `validate(schema, data, ext, {errors: true})` returns `{valid, errors}`; a valid instance has no errors, an invalid one has at least one error `{keyword, instancePath}` naming a keyword of the schema (`"false"` for a false schema), with `instancePath` a string;
- `validate(schema, data, ext, {strict: true})` gives the same answer, and throws on a keyword it does not know;
- `compile(schema, ext)`, exported next to `validate`, returns a function of `data` giving the same true or false.
