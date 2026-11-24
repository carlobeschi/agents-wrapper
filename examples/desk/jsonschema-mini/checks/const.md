# const: const

The desk runs, in work/: `node ../checks/run-suite.js const.json`

It loads `validate` from work/validate.js and, for every test case in the files below, checks that
`validate(testCase.schema, test.data, testCase.externalSchemas || {})` returns exactly `test.valid`.
The test files are the official JSON Schema Test Suite (2020-12 cases only). You cannot read them; here is what they cover:

- const.json: const validation; const with object; const with array; const with null; const with false does not match 0; const with true does not match 1; const with [false] does not match [0]; const with [true] does not match [1]; const with {"a": false} does not match {"a": 0}; const with {"a": true} does not match {"a": 1}; const with 0 does not match other zero-like types; const with 1 does not match true; const with -2.0 matches integer and float types; float and integers are equal up to 64-bit representation limits; nul characters in strings; characters with the same visual representation but different codepoint; characters with the same visual representation, but different number of codepoints
