const path = require('path');
const { load, save } = require('./store');
const notes = require('./notes');

const file = process.env.NOTES_FILE || path.join(process.cwd(), 'notes.json');
const [cmd, ...args] = process.argv.slice(2);

try {
  const data = load(file);
  if (cmd === 'add') { const id = notes.add(data, args.join(' ')); save(file, data); console.log(`added ${id}`); }
  else if (cmd === 'list' || !cmd) console.log(notes.list(data).join('\n') || '(no notes)');
  else if (cmd === 'done') { notes.done(data, args[0]); save(file, data); }
  else if (cmd === 'delete') { notes.remove(data, args[0]); save(file, data); }
  else { console.error(`unknown command ${cmd}: use add, list, done or delete`); process.exitCode = 2; }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
