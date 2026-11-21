// Hidden tests for share links. `m` is what notes.js exports.
const assert = require('assert');
const DAY = 86_400_000;
const setup = m => {
  const clock = { t: 1_000_000 };
  const s = new m.NotesService({ now: () => clock.t });
  const u = s.addUser('Ada'), v = s.addUser('Bo');
  return { s, u, v, clock };
};
const sameError = (m, fns) => {
  const msgs = fns.map(f => { try { f(); } catch (e) { assert.ok(e instanceof m.NotFoundError, `${e && e.name} instead of NotFoundError`); return e.message; } throw new Error('did not throw'); });
  assert.ok(msgs.every(x => x === msgs[0]), `different messages: ${JSON.stringify(msgs)}`);
};

module.exports = {
  base_still_works(m) {
    const { s, u, v } = setup(m);
    const n = s.createNote(u, 'one', ['t']);
    assert.strictEqual(s.getNote(u, n.id).text, 'one');
    assert.throws(() => s.getNote(v, n.id), m.ForbiddenError);
    s.updateNote(u, n.id, 'two');
    assert.strictEqual(s.listNotes(u)[0].text, 'two');
    s.deleteNote(u, n.id);
    assert.strictEqual(s.listNotes(u).length, 0);
  },
  only_the_owner_creates(m) {
    const { s, u, v } = setup(m);
    const n = s.createNote(u, 'secret');
    assert.throws(() => s.createShareLink(v, n.id), m.ForbiddenError);
    assert.throws(() => s.createShareLink(u, 'no-such-note'), m.NotFoundError);
    assert.throws(() => s.createShareLink('u999', n.id), m.NotFoundError);
  },
  ttl_is_checked(m) {
    const { s, u } = setup(m);
    const id = s.createNote(u, 'x').id;
    for (const bad of [0, -1, 1.5, '1000', NaN, Infinity, 30 * DAY + 1, null]) {
      assert.throws(() => s.createShareLink(u, id, bad), m.ValidationError, `ttl ${String(bad)}`);
    }
    s.createShareLink(u, id, 1);
    s.createShareLink(u, id, 30 * DAY);
  },
  default_is_one_day(m) {
    const { s, u, clock } = setup(m);
    const token = s.createShareLink(u, s.createNote(u, 'x').id);
    clock.t += DAY - 1;
    s.openShareLink(token);
    clock.t += 1;
    assert.throws(() => s.openShareLink(token), m.NotFoundError);
  },
  expires_at_the_exact_moment(m) {
    const { s, u, clock } = setup(m);
    const token = s.createShareLink(u, s.createNote(u, 'x').id, 1000);
    clock.t += 999;
    s.openShareLink(token);
    clock.t += 1;
    assert.throws(() => s.openShareLink(token), m.NotFoundError);
  },
  only_the_owner_revokes(m) {
    const { s, u, v } = setup(m);
    const token = s.createShareLink(u, s.createNote(u, 'x').id);
    assert.throws(() => s.revokeShareLink(v, token), m.ForbiddenError);
    assert.strictEqual(s.openShareLink(token).text, 'x');
    assert.throws(() => s.revokeShareLink(u, 'no-such-token'), m.NotFoundError);
  },
  deleting_the_note_ends_its_links(m) {
    const { s, u } = setup(m);
    const n = s.createNote(u, 'x');
    const token = s.createShareLink(u, n.id);
    s.deleteNote(u, n.id);
    assert.throws(() => s.openShareLink(token), m.NotFoundError);
  },
  shows_the_note_as_it_is_now(m) {
    const { s, u } = setup(m);
    const n = s.createNote(u, 'old', ['a']);
    const token = s.createShareLink(u, n.id);
    s.updateNote(u, n.id, 'new', ['b']);
    const r = s.openShareLink(token);
    assert.strictEqual(r.text, 'new');
    assert.deepStrictEqual(r.tags, ['b']);
  },
  gives_away_only_id_text_tags(m) {
    const { s, u } = setup(m);
    const n = s.createNote(u, 'x', ['a']);
    const r = s.openShareLink(s.createShareLink(u, n.id));
    assert.deepStrictEqual(Object.keys(r).sort(), ['id', 'tags', 'text']);
    r.tags.push('changed');
    assert.deepStrictEqual(s.getNote(u, n.id).tags, ['a'], 'the returned tags are the note\'s own array');
  },
  same_error_whatever_the_reason(m) {
    const { s, u, clock } = setup(m);
    const a = s.createShareLink(u, s.createNote(u, 'x').id, 10);
    const b = s.createShareLink(u, s.createNote(u, 'y').id);
    s.revokeShareLink(u, b);
    const n = s.createNote(u, 'z');
    const c = s.createShareLink(u, n.id);
    s.deleteNote(u, n.id);
    clock.t += 20;
    sameError(m, [() => s.openShareLink(a), () => s.openShareLink(b), () => s.openShareLink(c), () => s.openShareLink('no-such-token')]);
  },
  odd_tokens_are_not_found(m) {
    const { s } = setup(m);
    for (const t of [undefined, null, 42, {}, [], '', '__proto__', 'constructor', 'toString']) {
      assert.throws(() => s.openShareLink(t), m.NotFoundError, `token ${JSON.stringify(t)}`);
    }
  },
  tokens_are_url_safe_and_long(m) {
    const { s, u } = setup(m);
    const id = s.createNote(u, 'x').id;
    for (let i = 0; i < 20; i++) {
      const t = s.createShareLink(u, id);
      assert.match(t, /^[A-Za-z0-9_-]+$/);
      assert.ok(t.length >= 16, `token "${t}" is short`);
      assert.ok(!t.includes(id), 'token contains the note id');
    }
  },
  tokens_cannot_be_guessed(m) {
    // Math.random and the clock are fixed: tokens must still differ between two
    // services built the same way, so they come from a secure random source.
    Math.random = () => 0.42;
    const make = () => { const s = new m.NotesService({ now: () => 5 }); const u = s.addUser('Ada'); return s.createShareLink(u, s.createNote(u, 'x').id); };
    assert.notStrictEqual(make(), make());
  },
  fast_with_many_links(m) {
    const { s, u } = setup(m);
    const tokens = [];
    for (let i = 0; i < 100_000; i++) tokens.push(s.createShareLink(u, s.createNote(u, `note ${i}`).id, 7 * DAY));
    const t0 = Date.now();
    for (let i = 0; i < 20_000; i++) s.openShareLink(tokens[(i * 7919) % tokens.length]);
    assert.ok(Date.now() - t0 < 1500, `20,000 opens took ${Date.now() - t0} ms`);
  },
};
