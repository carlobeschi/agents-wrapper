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

const DAY = 86_400_000;
const GONE = 'no such link';
class Shared extends NotesService {
  constructor(o) { super(o); this.links = new Map(); }
  createShareLink(userId, noteId, ttlMs = DAY) {
    const note = this._own(userId, noteId);
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 30 * DAY) throw new ValidationError('ttlMs');
    const token = crypto.randomBytes(24).toString('base64url');
    this.links.set(token, { noteId: note.id, expires: this.now() + ttlMs });
    return token;
  }
  _link(token) {
    const l = typeof token === 'string' && this.links.has(token) ? this.links.get(token) : null;
    if (!l) throw new NotFoundError(GONE);
    return l;
  }
  openShareLink(token) {
    const l = this._link(token);
    const n = this.notes.get(l.noteId);
    if (!n || this.now() >= l.expires) { this.links.delete(token); throw new NotFoundError(GONE); }
    return { id: n.id, text: n.text, tags: [...n.tags] };
  }
  revokeShareLink(userId, token) {
    const l = this._link(token);
    this._own(userId, l.noteId);
    this.links.delete(token);
  }
}
module.exports = { NotesService: Shared, NotFoundError, ForbiddenError, ValidationError, MAX_TEXT };
