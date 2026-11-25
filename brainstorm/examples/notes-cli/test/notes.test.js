const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const run = (file, ...args) => execFileSync('node', [CLI, ...args], { env: { ...process.env, NOTES_FILE: file }, encoding: 'utf8' }).trim();

test('add, list, done, delete', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'notes-')), 'notes.json');
  assert.strictEqual(run(file, 'add', 'buy', 'cat', 'food'), 'added 1');
  run(file, 'add', 'call the vet');
  run(file, 'done', '1');
  assert.strictEqual(run(file, 'list'), '[x] 1. buy cat food\n[ ] 2. call the vet');
  run(file, 'delete', '1');
  assert.strictEqual(run(file, 'list'), '[ ] 2. call the vet');
});

test('an existing version 1 file still loads', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'notes-')), 'notes.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, notes: [{ id: 7, text: 'old note', created: '2025-01-01T00:00:00.000Z', done: false }] }));
  assert.strictEqual(run(file, 'list'), '[ ] 7. old note');
});
