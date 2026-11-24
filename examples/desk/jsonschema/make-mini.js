#!/usr/bin/env node
// Builds a cheap version of the JSON Schema round from the full one:
//   node examples/desk/jsonschema/make-mini.js
// The simple keywords only (11 tasks plus "everything together"), a $2 cap,
// written to examples/desk/jsonschema-mini. The set must be closed: every
// task it needs is in it.
const fs = require('fs');
const path = require('path');
const FULL = __dirname, OUT = path.join(__dirname, '..', 'jsonschema-mini');
const KEEP = ['core', 'type', 'enum', 'const', 'numbers', 'strings', 'required', 'propertyCounts', 'itemCounts', 'dependentRequired', 'patternProperties'];

const full = JSON.parse(fs.readFileSync(path.join(FULL, 'goal.json'), 'utf8'));
const tasks = full.tasks.filter(t => KEEP.includes(t.id));
for (const t of tasks) for (const n of t.needs) if (!KEEP.includes(n)) throw new Error(`${t.id} needs ${n}, which is not in the mini set`);
const files = tasks.flatMap(t => t.check.slice(2).filter(a => !a.startsWith('--')));
// Cases that use keywords of tasks outside the mini set can never pass here:
// they are left out everywhere, "all" included.
const outside = full.tasks.filter(t => t.owns && !KEEP.includes(t.id)).flatMap(t => t.owns);
const all = full.tasks.find(t => t.id === 'all');
tasks.push({ ...all, needs: [...KEEP], check: ['node', '../checks/run-suite.js', '--all', `--skip-keywords=${outside.join(',')}`], detail: 'All the tests of the other tasks pass at once: fix whatever breaks when the keywords meet.' });
for (const t of tasks) {
  const skip = t.check.find(a => a.startsWith('--skip-keywords=')) || '--skip-keywords=';
  const merged = [...new Set([...skip.slice(16).split(',').filter(Boolean), ...outside])];
  t.check = [...t.check.filter(a => !a.startsWith('--skip-keywords=')), `--skip-keywords=${merged.join(',')}`];
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'checks'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'suite'));
for (const f of [...files, 'LICENSE']) fs.copyFileSync(path.join(FULL, 'suite', f), path.join(OUT, 'suite', f));
fs.copyFileSync(path.join(FULL, 'checks', 'run-suite.js'), path.join(OUT, 'checks', 'run-suite.js'));
for (const t of tasks) fs.copyFileSync(path.join(FULL, t.spec), path.join(OUT, t.spec));
const total = files.reduce((n, f) => n + JSON.parse(fs.readFileSync(path.join(OUT, 'suite', f), 'utf8')).reduce((m, c) => m + c.tests.length, 0), 0);
fs.writeFileSync(path.join(OUT, 'checks', 'all.md'), `# all: Everything together\n\nThe desk runs, in work/: \`node ../checks/run-suite.js --all\`: all the tests of the other tasks at once (cases that need keywords outside this round are left out).\n`);
const goal = {
  ...full,
  goal: full.goal.replace('Write a JSON Schema validator for draft 2020-12', 'Write the simple part of a JSON Schema validator for draft 2020-12 (no $ref, no applicators such as allOf or properties)'),
  // The final check skips the same cases as "all": with them in, a validator
  // that ignores an outside keyword (say properties) still passed most of
  // them, so the total said less than it seemed (24 Nov, mini runs).
  settings: { ...full.settings, budget_usd: 2, final_check: ['node', '../checks/run-suite.js', '--all', `--skip-keywords=${outside.join(',')}`] },
  tasks,
};
fs.writeFileSync(path.join(OUT, 'goal.json'), JSON.stringify(goal, null, 2) + '\n');
console.log(`${tasks.length} tasks, ${total} tests, in ${OUT}`);

// The same round with a goal that says nothing about how to coordinate (no
// README, no shared structure), for the repeats: in the first runs the group
// and the solo agent both wrote the README the goal suggested (24 Nov), so
// that goal could not show whether agents set up a protocol by themselves.
const PLAIN = path.join(__dirname, '..', 'jsonschema-mini-plain');
const COORD = ' Several workers write in the same folder at once: agree on the structure through the files themselves (for example a README.md in work/ describing how keywords plug in) and do not break what others got accepted.';
if (!goal.goal.includes(COORD)) throw new Error('the coordination sentence is not in the goal any more: update make-mini.js');
fs.rmSync(PLAIN, { recursive: true, force: true });
fs.cpSync(OUT, PLAIN, { recursive: true });
fs.writeFileSync(path.join(PLAIN, 'goal.json'), JSON.stringify({ ...goal, goal: goal.goal.replace(COORD, '') }, null, 2) + '\n');
console.log(`The same with a goal that says nothing about coordination, in ${PLAIN}`);
