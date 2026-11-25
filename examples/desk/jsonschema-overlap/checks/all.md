# all: Everything together

The desk runs, in work/: `node ../checks/run-suite.js --all --require=errors,strict,compile`: all the tests of the round, in all four ways of calling the validator (cases that need keywords outside this round are left out).


If validate.js offers any of these ways of calling it, the check also judges every case that way (they are added by the tasks "errors", "strict" and "compile"):
- `validate(schema, data, ext, {errors: true})` returns `{valid, errors}`; a valid instance has no errors, an invalid one has at least one error `{keyword, instancePath}` naming a keyword of the schema (`"false"` for a false schema), with `instancePath` a string;
- `validate(schema, data, ext, {strict: true})` gives the same answer, and throws on a keyword it does not know;
- `compile(schema, ext)`, exported next to `validate`, returns a function of `data` giving the same true or false.
