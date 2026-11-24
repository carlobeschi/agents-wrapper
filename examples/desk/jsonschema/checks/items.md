# items: items and prefixItems

The desk runs, in work/: `node ../checks/run-suite.js items.json`

It loads `validate` from work/validate.js and, for every test case in the files below, checks that
`validate(testCase.schema, test.data, testCase.externalSchemas || {})` returns exactly `test.valid`.
The test files are the official JSON Schema Test Suite (2020-12 cases only). You cannot read them; here is what they cover:

- items.json: a schema given for items; a schema given for prefixItems; items with boolean schema (true); items with boolean schema (false); prefixItems with boolean schemas; items and subitems; nested items; items with null instance elements; prefixItems with null instance elements; prefixItems with no additional items permitted; additional items are allowed by default; items does not look in applicators, valid case; prefixItems validation adjusts the starting index for items; prefixItems with heterogeneous array
