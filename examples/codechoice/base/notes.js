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

module.exports = { NotesService, NotFoundError, ForbiddenError, ValidationError, MAX_TEXT };
