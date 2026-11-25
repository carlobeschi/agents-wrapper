# compile: Compile once, validate many times

The desk runs, in work/: `node ../checks/run-suite.js --all --skip-keywords=<keywords outside this round> --require=compile --contracts --only-working`

It fails if validate.js does not offer this way of calling it. Then, for every case of the round that plain validate already gets right, it checks the answer this way too (and every other way validate.js already offers). Cases no keyword handles yet are not judged here; their own tasks will be judged this way later.


If validate.js offers any of these ways of calling it, the check also judges every case that way (they are added by the tasks "errors", "strict" and "compile"):
- `validate(schema, data, ext, {errors: true})` returns `{valid, errors}`; a valid instance has no errors, an invalid one has at least one error `{keyword, instancePath}` naming a keyword of the schema (`"false"` for a false schema), with `instancePath` a string;
- `validate(schema, data, ext, {strict: true})` gives the same answer, and throws on a keyword it does not know;
- `compile(schema, ext)`, exported next to `validate`, returns a function of `data` giving the same true or false.
