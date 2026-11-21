// Visible tests for importCsv. `m` is what notes.js exports.
const assert = require('assert');
const setup = m => { const s = new m.NotesService({ now: () => 1_000_000 }); return { s, u: s.addUser('Ada') }; };
const texts = (s, u) => s.listNotes(u).map(n => n.text).sort();

module.exports = {
  imports_simple_rows(m) {
    const { s, u } = setup(m);
    const r = s.importCsv(u, 'text,tags\nfirst note,work\nsecond note,home;todo\n');
    assert.deepStrictEqual(r, { imported: 2, errors: [] });
    assert.deepStrictEqual(texts(s, u), ['first note', 'second note']);
    assert.deepStrictEqual(s.listNotes(u).find(n => n.text === 'second note').tags, ['home', 'todo']);
  },
  tags_column_is_optional(m) {
    const { s, u } = setup(m);
    assert.strictEqual(s.importCsv(u, 'text\nonly text\n').imported, 1);
  },
  needs_a_text_column(m) {
    const { s, u } = setup(m);
    assert.throws(() => s.importCsv(u, 'title,tags\nx,y\n'), m.ValidationError);
    assert.strictEqual(s.listNotes(u).length, 0);
  },
};
