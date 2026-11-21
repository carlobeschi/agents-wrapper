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

function parseCsv(text) {
  // Records with the line each starts on. RFC 4180, \n or \r\n.
  const out = []; let field = '', row = [], q = false, line = 1, start = 1, any = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else { if (ch === '\n') line++; field += ch; }
      continue;
    }
    if (ch === '"') { q = true; any = true; }
    else if (ch === ',') { row.push(field); field = ''; any = true; }
    else if (ch === '\r' && text[i + 1] === '\n') continue;
    else if (ch === '\n') { if (any || field) { row.push(field); out.push({ line: start, row }); } row = []; field = ''; any = false; line++; start = line; }
    else { field += ch; any = true; }
  }
  if (any || field) { row.push(field); out.push({ line: start, row }); }
  return out;
}
class Csv extends NotesService {
  importCsv(userId, csv) {
    this._user(userId);
    if (typeof csv !== 'string' || csv.length > 1_000_000) throw new ValidationError('csv');
    const recs = parseCsv(csv.replace(/^\uFEFF/, ''));
    if (!recs.length) throw new ValidationError('no header');
    const head = recs.shift().row.map(h => h.trim());
    const ti = head.indexOf('text'), gi = head.indexOf('tags');
    if (ti < 0) throw new ValidationError('no text column');
    if (recs.length > 5000) throw new ValidationError('too many records');
    let imported = 0; const errors = [];
    for (const { line, row } of recs) {
      const tags = gi < 0 || !(row[gi] || '').trim() ? [] : row[gi].split(';').map(t => t.trim());
      try { this.createNote(userId, row[ti] ?? '', tags); imported++; }
      catch (e) { errors.push({ line, reason: e.message }); }
    }
    return { imported, errors };
  }
}
module.exports = { NotesService: Csv, NotFoundError, ForbiddenError, ValidationError, MAX_TEXT };
