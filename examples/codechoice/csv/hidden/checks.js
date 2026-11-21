// Hidden tests for importCsv. `m` is what notes.js exports.
const assert = require('assert');
const setup = m => { const s = new m.NotesService({ now: () => 1_000_000 }); return { s, u: s.addUser('Ada'), v: s.addUser('Bo') }; };
const texts = (s, u) => s.listNotes(u).map(n => n.text).sort();

module.exports = {
  base_still_works(m) {
    const { s, u, v } = setup(m);
    const n = s.createNote(u, 'one', ['t']);
    assert.throws(() => s.getNote(v, n.id), m.ForbiddenError);
    s.updateNote(u, n.id, 'two');
    assert.strictEqual(s.getNote(u, n.id).text, 'two');
    s.deleteNote(u, n.id);
    assert.strictEqual(s.listNotes(u).length, 0);
  },
  quoted_commas(m) {
    const { s, u } = setup(m);
    s.importCsv(u, 'text,tags\n"Milk, eggs, bread",shop\n');
    assert.deepStrictEqual(texts(s, u), ['Milk, eggs, bread']);
  },
  doubled_quotes(m) {
    const { s, u } = setup(m);
    s.importCsv(u, 'text\n"She said ""hi"" twice"\n"""quoted"""\n');
    assert.deepStrictEqual(texts(s, u), ['"quoted"', 'She said "hi" twice']);
  },
  line_breaks_in_quotes(m) {
    const { s, u } = setup(m);
    const r = s.importCsv(u, 'text,tags\n"line one\nline two",a\nnext,b\n');
    assert.strictEqual(r.imported, 2);
    assert.deepStrictEqual(texts(s, u), ['line one\nline two', 'next']);
  },
  windows_line_ends(m) {
    const { s, u } = setup(m);
    s.importCsv(u, 'text,tags\r\nfirst,a\r\nsecond,b\r\n');
    assert.deepStrictEqual(texts(s, u), ['first', 'second']);
    assert.deepStrictEqual(s.listNotes(u).find(n => n.text === 'first').tags, ['a']);
  },
  byte_order_mark(m) {
    const { s, u } = setup(m);
    assert.strictEqual(s.importCsv(u, '\uFEFFtext,tags\nhello,a\n').imported, 1);
  },
  columns_in_any_order(m) {
    const { s, u } = setup(m);
    s.importCsv(u, 'id,tags,text,colour\n7,a;b,the text,red\n');
    const [n] = s.listNotes(u);
    assert.strictEqual(n.text, 'the text');
    assert.deepStrictEqual(n.tags, ['a', 'b']);
  },
  the_file_cannot_choose_the_owner(m) {
    const { s, u, v } = setup(m);
    s.importCsv(u, `text,owner\nmine,${v}\nalso mine,u2\n`);
    assert.strictEqual(s.listNotes(u).length, 2);
    assert.strictEqual(s.listNotes(v).length, 0);
  },
  bad_records_reported_with_their_line(m) {
    const { s, u } = setup(m);
    const csv = 'text,tags\nok one,a\n,b\n"two\nlines",c\nbad tag,NOT OK\nok two,d\n';
    const r = s.importCsv(u, csv);
    assert.strictEqual(r.imported, 3);
    assert.deepStrictEqual(r.errors.map(e => e.line), [3, 6]);
    assert.ok(r.errors.every(e => typeof e.reason === 'string' && e.reason.length > 0));
  },
  tags_trimmed_and_empty(m) {
    const { s, u } = setup(m);
    s.importCsv(u, 'text,tags\nfirst, a ; b \nsecond,\n');
    assert.deepStrictEqual(s.listNotes(u).find(n => n.text === 'first').tags, ['a', 'b']);
    assert.deepStrictEqual(s.listNotes(u).find(n => n.text === 'second').tags, []);
  },
  empty_lines_skipped(m) {
    const { s, u } = setup(m);
    const r = s.importCsv(u, 'text\n\nfirst\n\n\nsecond\n\n');
    assert.deepStrictEqual(r, { imported: 2, errors: [] });
  },
  too_big_imports_nothing(m) {
    const { s, u } = setup(m);
    // 4,000 records (under the record limit), 1,000,001 characters (one over).
    let csv = 'text\n' + ('x'.repeat(249) + '\n').repeat(3999);
    csv += 'y'.repeat(1_000_001 - csv.length);
    assert.strictEqual(csv.length, 1_000_001);
    assert.throws(() => s.importCsv(u, csv), m.ValidationError);
    assert.strictEqual(s.listNotes(u).length, 0);
  },
  too_many_records_imports_nothing(m) {
    const { s, u } = setup(m);
    assert.throws(() => s.importCsv(u, 'text\n' + 'n\n'.repeat(5001)), m.ValidationError);
    assert.strictEqual(s.listNotes(u).length, 0);
    assert.strictEqual(s.importCsv(u, 'text\n' + 'n\n'.repeat(5000)).imported, 5000);
  },
  unknown_user(m) {
    const { s } = setup(m);
    assert.throws(() => s.importCsv('u999', 'text\nx\n'), m.NotFoundError);
  },
  not_text_input(m) {
    const { s, u } = setup(m);
    for (const bad of [undefined, null, 42, {}, ['text', 'x']]) assert.throws(() => s.importCsv(u, bad), m.ValidationError, `input ${JSON.stringify(bad)}`);
  },
  fast_on_a_big_file(m) {
    const { s, u } = setup(m);
    const csv = 'text,tags\n' + Array.from({ length: 5000 }, (_, i) => `"Note ${i}, with a comma and ""quotes"" ${'z'.repeat(150)}",tag-${i % 10};x\n`).join('');
    const t0 = Date.now();
    assert.strictEqual(s.importCsv(u, csv).imported, 5000);
    assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
  },
};
