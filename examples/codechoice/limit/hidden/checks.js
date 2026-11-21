// Hidden tests for the write limit. `m` is what notes.js exports.
const assert = require('assert');
const setup = (m, opts) => { const clock = { t: 1_000_000 }; const s = new m.NotesService({ now: () => clock.t, ...opts }); return { s, u: s.addUser('Ada'), v: s.addUser('Bo'), clock }; };
const limited = (m, f) => { try { f(); } catch (e) { assert.ok(e instanceof m.RateLimitError, `${e && e.name}: ${e && e.message}`); return e; } throw new Error('was not limited'); };

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
  defaults_30_a_minute(m) {
    const { s, u, clock } = setup(m);
    for (let i = 0; i < 30; i++) { s.createNote(u, `n${i}`); clock.t += 100; }
    limited(m, () => s.createNote(u, 'x'));
    clock.t = 1_000_000 + 60_000;
    s.createNote(u, 'first one has left the window');
  },
  a_sliding_window(m) {
    const { s, u, clock } = setup(m, { writeLimit: 3, writeWindowMs: 1000 });
    for (const t of [0, 900, 950]) { clock.t = 1_000_000 + t; s.createNote(u, `at ${t}`); }
    clock.t = 1_000_000 + 999; limited(m, () => s.createNote(u, 'x'));
    clock.t = 1_000_000 + 1000; s.createNote(u, 'the write at 0 no longer counts');
    clock.t = 1_000_000 + 1001; limited(m, () => s.createNote(u, 'x'));
    clock.t = 1_000_000 + 1900; s.createNote(u, 'the write at 900 no longer counts');
  },
  retry_after_is_exact(m) {
    const { s, u, clock } = setup(m, { writeLimit: 3, writeWindowMs: 1000 });
    for (const t of [0, 100, 200]) { clock.t = 1_000_000 + t; s.createNote(u, `at ${t}`); }
    clock.t = 1_000_000 + 500;
    assert.strictEqual(limited(m, () => s.createNote(u, 'x')).retryAfterMs, 500);
    clock.t = 1_000_000 + 999;
    assert.strictEqual(limited(m, () => s.createNote(u, 'x')).retryAfterMs, 1);
  },
  update_and_delete_count(m) {
    const { s, u } = setup(m, { writeLimit: 3, writeWindowMs: 1000 });
    const n = s.createNote(u, 'a');
    s.updateNote(u, n.id, 'b');
    s.deleteNote(u, n.id);
    limited(m, () => s.createNote(u, 'x'));
  },
  failed_writes_do_not_count(m) {
    const { s, u, v } = setup(m, { writeLimit: 2, writeWindowMs: 1000 });
    const other = s.createNote(v, 'not yours');
    for (let i = 0; i < 5; i++) {
      assert.throws(() => s.createNote(u, ''), m.ValidationError);
      assert.throws(() => s.updateNote(u, 'missing', 'x'), m.NotFoundError);
      assert.throws(() => s.deleteNote(u, other.id), m.ForbiddenError);
    }
    s.createNote(u, 'a'); s.createNote(u, 'b');
  },
  others_cannot_use_up_your_limit(m) {
    const { s, u, v } = setup(m, { writeLimit: 2, writeWindowMs: 1000 });
    const mine = s.createNote(u, 'mine');
    for (let i = 0; i < 20; i++) assert.throws(() => s.deleteNote(v, mine.id), m.ForbiddenError);
    s.updateNote(u, mine.id, 'still mine');
    s.createNote(v, 'b1'); s.createNote(v, 'b2');
    limited(m, () => s.createNote(v, 'b3'));
    limited(m, () => s.createNote(u, 'a3'));
  },
  limited_attempts_do_not_count(m) {
    const { s, u, clock } = setup(m, { writeLimit: 2, writeWindowMs: 1000 });
    clock.t = 1_000_000; s.createNote(u, 'a');
    clock.t = 1_000_010; s.createNote(u, 'b');
    clock.t = 1_000_500; for (let i = 0; i < 5; i++) limited(m, () => s.createNote(u, 'x'));
    clock.t = 1_001_000; s.createNote(u, 'c');
    clock.t = 1_001_005; limited(m, () => s.createNote(u, 'x'));
    clock.t = 1_001_010; s.createNote(u, 'd');
  },
  the_limit_is_checked_first(m) {
    const { s, u } = setup(m, { writeLimit: 1, writeWindowMs: 1000 });
    s.createNote(u, 'a');
    limited(m, () => s.createNote(u, ''));
    limited(m, () => s.updateNote(u, 'missing', 'x'));
  },
  a_limited_write_changes_nothing(m) {
    const { s, u } = setup(m, { writeLimit: 1, writeWindowMs: 1000 });
    const n = s.createNote(u, 'a');
    limited(m, () => s.createNote(u, 'b'));
    limited(m, () => s.updateNote(u, n.id, 'changed'));
    limited(m, () => s.deleteNote(u, n.id));
    assert.deepStrictEqual(s.listNotes(u).map(x => x.text), ['a']);
  },
  reads_never_limited(m) {
    const { s, u } = setup(m, { writeLimit: 1, writeWindowMs: 1000 });
    const n = s.createNote(u, 'a');
    for (let i = 0; i < 200; i++) { s.getNote(u, n.id); s.listNotes(u); }
    limited(m, () => s.createNote(u, 'b'));
  },
  a_proper_error(m) {
    assert.strictEqual(typeof m.RateLimitError, 'function');
    const { s, u } = setup(m, { writeLimit: 1, writeWindowMs: 1000 });
    s.createNote(u, 'a');
    const e = limited(m, () => s.createNote(u, 'b'));
    assert.ok(e instanceof Error);
    assert.ok(typeof e.retryAfterMs === 'number' && e.retryAfterMs > 0);
  },
  fast_with_a_big_limit(m) {
    const { s, u, clock } = setup(m, { writeLimit: 100_000, writeWindowMs: 1e9 });
    const t0 = Date.now();
    for (let i = 0; i < 100_000; i++) { clock.t++; s.createNote(u, 'n'); }
    limited(m, () => s.createNote(u, 'x'));
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  },
  does_not_keep_old_writes(m) {
    // 200,000 writes, never more than 100 in the window: work per write must not grow with history.
    const { s, u, clock } = setup(m, { writeLimit: 100, writeWindowMs: 100 });
    const n = s.createNote(u, 'n');
    const t0 = Date.now();
    for (let i = 0; i < 200_000; i++) { clock.t += 1; s.updateNote(u, n.id, 'n'); }
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  },
};
