# ifThenElse: if, then, else

The desk runs, in work/: `node ../checks/run-suite.js if-then-else.json`

It loads `validate` from work/validate.js and, for every test case in the files below, checks that
`validate(testCase.schema, test.data, testCase.externalSchemas || {})` returns exactly `test.valid`.
The test files are the official JSON Schema Test Suite (2020-12 cases only). You cannot read them; here is what they cover:

- if-then-else.json: ignore if without then or else; ignore then without if; ignore else without if; if and then without else; if and else without then; validate against correct branch, then vs else; non-interference across combined schemas; if with boolean schema true; if with boolean schema false; if appears at the end when serialized (keyword processing sequence); then: false fails when condition matches; else: false fails when condition does not match
