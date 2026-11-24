// Judge for b1: the written spec of the KPI tree, checked by a program.
// Run by the desk from work/: node ../checks/kpi-tree.check.js
// Exit 0 = accepted. It checks shape and completeness, not wisdom: a person
// still reads the tree in the later tasks.
//
// kpi-tree.json:
// { "top": { "name": "...", "why": "...", "measure": "...", "better": "up" | "down" },
//   "drivers": [ { "name": "...", "why": "...",
//                  "indicators": [ { "name": "...", "measure": "...", "data": "...",
//                                    "better": "up" | "down", "gaming": "...", "level": "team" } ] } ] }
const fs = require('fs');
const problems = [];
let tree;
try { tree = JSON.parse(fs.readFileSync('kpi-tree.json', 'utf8')); } catch (e) { console.log(`kpi-tree.json is missing or not JSON: ${e.message}`); process.exit(1); }
const text = (v, where) => { if (typeof v !== 'string' || v.trim().length < 3) problems.push(`${where} must be a non-empty text`); };
const dir = (v, where) => { if (!['up', 'down'].includes(v)) problems.push(`${where}.better must be "up" or "down"`); };
const top = tree.top || {};
['name', 'why', 'measure'].forEach(k => text(top[k], `top.${k}`));
dir(top.better, 'top');
const drivers = Array.isArray(tree.drivers) ? tree.drivers : [];
if (drivers.length < 3 || drivers.length > 5) problems.push(`there must be 3 to 5 drivers, not ${drivers.length}`);
const names = new Set();
drivers.forEach((d, i) => {
  ['name', 'why'].forEach(k => text(d[k], `drivers[${i}].${k}`));
  const inds = Array.isArray(d.indicators) ? d.indicators : [];
  if (inds.length < 1 || inds.length > 3) problems.push(`drivers[${i}] must have 1 to 3 indicators, not ${inds.length}`);
  inds.forEach((x, j) => {
    const w = `drivers[${i}].indicators[${j}]`;
    ['name', 'measure', 'data', 'gaming'].forEach(k => text(x[k], `${w}.${k}`));
    dir(x.better, w);
    if (x.level !== 'team') problems.push(`${w}.level must be "team": no indicator may be about one person`);
    if (names.has(x.name)) problems.push(`indicator name "${x.name}" is used twice`);
    names.add(x.name);
  });
});
if (problems.length) { console.log(problems.join('\n')); process.exit(1); }
console.log(`kpi-tree.json accepted: ${drivers.length} drivers, ${names.size} indicators.`);
