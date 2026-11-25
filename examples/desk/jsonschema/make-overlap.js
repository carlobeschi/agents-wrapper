#!/usr/bin/env node
// Builds the overlap round from the plain mini round:
//   node examples/desk/jsonschema/make-mini.js && node examples/desk/jsonschema/make-overlap.js
// Same keyword tasks, plus three tasks that change how every keyword is called
// (errors, strict, compile). They need only core, so they are open at the same
// time as the keyword tasks: workers have to change code others are building
// on. Every keyword task is also judged in each contract validate.js already
// offers. Design: work/desk-overlap-design-en.md in the project files.
const fs = require('fs');
const path = require('path');
const FROM = path.join(__dirname, '..', 'jsonschema-mini-plain'), OUT = path.join(__dirname, '..', 'jsonschema-overlap');

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(FROM, OUT, { recursive: true });
const goal = JSON.parse(fs.readFileSync(path.join(OUT, 'goal.json'), 'utf8'));
const all = goal.tasks.find(t => t.id === 'all');
const skip = all.check.find(a => a.startsWith('--skip-keywords='));
const contractNote = `\n\nIf validate.js offers any of these ways of calling it, the check also judges every case that way (they are added by the tasks "errors", "strict" and "compile"):\n- \`validate(schema, data, ext, {errors: true})\` returns \`{valid, errors}\`; a valid instance has no errors, an invalid one has at least one error \`{keyword, instancePath}\` naming a keyword of the schema (\`"false"\` for a false schema), with \`instancePath\` a string;\n- \`validate(schema, data, ext, {strict: true})\` gives the same answer, and throws on a keyword it does not know;\n- \`compile(schema, ext)\`, exported next to \`validate\`, returns a function of \`data\` giving the same true or false.\n`;

const keywordTasks = goal.tasks.filter(t => t.id !== 'all');
for (const t of keywordTasks) {
  t.check = [...t.check, '--contracts'];
  const spec = path.join(OUT, t.spec);
  fs.writeFileSync(spec, fs.readFileSync(spec, 'utf8').replace(/`node \.\.\/checks\/run-suite\.js ([^`]*)`/, (m, a) => `\`node ../checks/run-suite.js ${a} --contracts\``) + contractNote);
}

const contract = {
  errors: { title: 'Error reports', detail: 'Add an option: validate(schema, data, externalSchemas, {errors: true}) returns {valid, errors}, where errors lists {keyword, instancePath} for what failed (keyword "false" for a false schema, instancePath a JSON Pointer string such as "" or "/foo"). Every keyword that works today must report its errors this way. Without the option, validate still returns true or false.' },
  strict: { title: 'Strict mode', detail: 'Add an option: validate(schema, data, externalSchemas, {strict: true}) throws when the schema uses a keyword the validator does not know (annotation keywords such as title or $comment count as known). Every keyword that works today must keep working in strict mode. Without the option, unknown keywords are ignored as before.' },
  compile: { title: 'Compile once, validate many times', detail: 'Export compile(schema, externalSchemas) next to validate: it returns a function of data that gives the same true or false as validate(schema, data, externalSchemas), doing the work that depends only on the schema once. Every keyword that works today must work through compile.' },
};
const added = Object.entries(contract).map(([id, c]) => {
  const check = ['node', '../checks/run-suite.js', '--all', skip, `--require=${id}`, '--contracts', '--only-working'];
  fs.writeFileSync(path.join(OUT, 'checks', `${id}.md`), `# ${id}: ${c.title}\n\nThe desk runs, in work/: \`${check.join(' ').replace(skip, '--skip-keywords=<keywords outside this round>')}\`\n\nIt fails if validate.js does not offer this way of calling it. Then, for every case of the round that plain validate already gets right, it checks the answer this way too (and every other way validate.js already offers). Cases no keyword handles yet are not judged here; their own tasks will be judged this way later.\n${contractNote}`);
  return { id, title: c.title, owns: [], detail: c.detail, needs: ['core'], spec: `checks/${id}.md`, check };
});
goal.tasks = [...keywordTasks, ...added, { ...all, needs: [...all.needs, ...added.map(t => t.id)], check: ['node', '../checks/run-suite.js', '--all', skip, '--require=errors,strict,compile'] }];
fs.writeFileSync(path.join(OUT, 'checks', 'all.md'), `# all: Everything together\n\nThe desk runs, in work/: \`node ../checks/run-suite.js --all --require=errors,strict,compile\`: all the tests of the round, in all four ways of calling the validator (cases that need keywords outside this round are left out).\n${contractNote}`);
goal.settings = { ...goal.settings, budget_usd: 3, final_check: ['node', '../checks/run-suite.js', '--all', skip, '--require=errors,strict,compile'] };
fs.writeFileSync(path.join(OUT, 'goal.json'), JSON.stringify(goal, null, 2) + '\n');
console.log(`${goal.tasks.length} tasks (${added.map(t => t.id).join(', ')} open from the start), in ${OUT}`);
