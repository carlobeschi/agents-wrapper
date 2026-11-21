// Visible tests for the write limit. `m` is what notes.js exports.
const assert = require('assert');
const setup = (m, opts) => { const clock = { t: 1_000_000 }; const s = new m.NotesService({ now: () => clock.t, ...opts }); return { s, u: s.addUser('Ada'), v: s.addUser('Bo'), clock }; };

module.exports = {
  stops_at_the_limit(m) {
    const { s, u } = setup(m, { writeLimit: 3, writeWindowMs: 1000 });
    for (let i = 0; i < 3; i++) s.createNote(u, `n${i}`);
    assert.throws(() => s.createNote(u, 'one too many'), m.RateLimitError);
  },
  allows_again_after_the_window(m) {
    const { s, u, clock } = setup(m, { writeLimit: 2, writeWindowMs: 1000 });
    s.createNote(u, 'a'); s.createNote(u, 'b');
    clock.t += 5000;
    s.createNote(u, 'c');
  },
  reads_are_not_limited(m) {
    const { s, u } = setup(m, { writeLimit: 1, writeWindowMs: 1000 });
    const n = s.createNote(u, 'a');
    for (let i = 0; i < 50; i++) { s.getNote(u, n.id); s.listNotes(u); }
  },
};
