// Visible tests for share links. `m` is what notes.js exports.
const assert = require('assert');
const setup = m => { const clock = { t: 1_000_000 }; const s = new m.NotesService({ now: () => clock.t }); const u = s.addUser('Ada'); return { s, u, clock }; };

module.exports = {
  open_a_link(m) {
    const { s, u } = setup(m);
    const n = s.createNote(u, 'hello', ['a']);
    const token = s.createShareLink(u, n.id);
    assert.strictEqual(typeof token, 'string');
    const r = s.openShareLink(token);
    assert.strictEqual(r.id, n.id);
    assert.strictEqual(r.text, 'hello');
    assert.deepStrictEqual(r.tags, ['a']);
  },
  a_link_expires(m) {
    const { s, u, clock } = setup(m);
    const token = s.createShareLink(u, s.createNote(u, 'x').id, 1000);
    clock.t += 500;
    s.openShareLink(token);
    clock.t += 1500;
    assert.throws(() => s.openShareLink(token), m.NotFoundError);
  },
  a_link_can_be_revoked(m) {
    const { s, u } = setup(m);
    const token = s.createShareLink(u, s.createNote(u, 'x').id);
    s.revokeShareLink(u, token);
    assert.throws(() => s.openShareLink(token), m.NotFoundError);
  },
};
