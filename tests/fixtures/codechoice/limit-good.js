// A small notes service, kept in memory. Users own notes; only the owner can
// read or change a note. Time comes from `now` (milliseconds), so tests can
// move the clock.
const crypto = require('crypto');

class NotFoundError extends Error { constructor(m = 'not found') { super(m); this.name = 'NotFoundError'; } }
class ForbiddenError extends Error { constructor(m = 'forbidden') { super(m); this.name = 'ForbiddenError'; } }
class ValidationError extends Error { constructor(m = 'invalid') { super(m); this.name = 'ValidationError'; } }

const MAX_TEXT = 10000;

class NotesService {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.users = new Map();   // id -> { id, name }
    this.notes = new Map();   // id -> { id, owner, text, tags, created, updated }
    this.nextUser = 1;
  }

  addUser(name) {
    if (typeof name !== 'string' || !name.trim()) throw new ValidationError('name');
    const id = `u${this.nextUser++}`;
    this.users.set(id, { id, name: name.trim() });
    return id;
  }

  _user(userId) {
    if (!this.users.has(userId)) throw new NotFoundError('user');
    return this.users.get(userId);
  }

  _check(text, tags) {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) throw new ValidationError('text');
    if (!Array.isArray(tags) || tags.some(t => typeof t !== 'string' || !/^[a-z0-9-]{1,30}$/.test(t))) throw new ValidationError('tags');
  }

  _own(userId, noteId) {
    this._user(userId);
    const note = this.notes.get(noteId);
    if (!note) throw new NotFoundError('note');
    if (note.owner !== userId) throw new ForbiddenError('not your note');
    return note;
  }

  createNote(userId, text, tags = []) {
    this._user(userId);
    this._check(text, tags);
    const t = this.now();
    const note = { id: crypto.randomUUID(), owner: userId, text, tags: [...new Set(tags)], created: t, updated: t };
    this.notes.set(note.id, note);
    return { ...note, tags: [...note.tags] };
  }

  getNote(userId, noteId) {
    const note = this._own(userId, noteId);
    return { ...note, tags: [...note.tags] };
  }

  listNotes(userId) {
    this._user(userId);
    return [...this.notes.values()].filter(n => n.owner === userId)
      .sort((a, b) => b.created - a.created).map(n => ({ ...n, tags: [...n.tags] }));
  }

  updateNote(userId, noteId, text, tags) {
    const note = this._own(userId, noteId);
    const next = tags === undefined ? note.tags : tags;
    this._check(text, next);
    note.text = text;
    note.tags = [...new Set(next)];
    note.updated = this.now();
    return { ...note, tags: [...note.tags] };
  }

  deleteNote(userId, noteId) {
    this._own(userId, noteId);
    this.notes.delete(noteId);
  }
}

class RateLimitError extends Error { constructor(retryAfterMs) { super(`too many writes; retry in ${retryAfterMs} ms`); this.name = 'RateLimitError'; this.retryAfterMs = retryAfterMs; } }
class Limited extends NotesService {
  constructor({ writeLimit = 30, writeWindowMs = 60000, ...o } = {}) { super(o); this.writeLimit = writeLimit; this.writeWindowMs = writeWindowMs; this.writes = new Map(); }
  _gate(userId) {
    const q = this.writes.get(userId);
    if (!q) return;
    const t = this.now();
    while (q.head < q.times.length && q.times[q.head] + this.writeWindowMs <= t) q.head++;
    if (q.head > 1024 && q.head * 2 > q.times.length) { q.times = q.times.slice(q.head); q.head = 0; }
    if (q.times.length - q.head >= this.writeLimit) throw new RateLimitError(q.times[q.head] + this.writeWindowMs - t);
  }
  _count(userId) {
    let q = this.writes.get(userId);
    if (!q) this.writes.set(userId, q = { times: [], head: 0 });
    q.times.push(this.now());
  }
  _write(userId, f) { this._gate(userId); const r = f(); this._count(userId); return r; }
  createNote(u, ...a) { return this._write(u, () => super.createNote(u, ...a)); }
  updateNote(u, ...a) { return this._write(u, () => super.updateNote(u, ...a)); }
  deleteNote(u, ...a) { return this._write(u, () => super.deleteNote(u, ...a)); }
}
module.exports = { NotesService: Limited, NotFoundError, ForbiddenError, ValidationError, RateLimitError, MAX_TEXT };
