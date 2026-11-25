// Reading and writing the notes file. Version 1 of the format.
const fs = require('fs');

const EMPTY = () => ({ version: 1, notes: [] });

function load(file) {
  if (!fs.existsSync(file)) return EMPTY();
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.version !== 1 || !Array.isArray(data.notes)) throw new Error(`${file}: not a notes file this version can read`);
  return data;
}

function save(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

module.exports = { load, save };
