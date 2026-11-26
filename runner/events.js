// @ts-check
// The event record of a run: one append-only events.jsonl, and the full texts
// (prompts as shown, raw replies) in payloads/, one file per text, named by
// its SHA-256 and readable by the owner only. An event refers to a text by its
// hash, so the record can be read, counted and shared without the case texts
// in it. Nothing in an event is ever changed or removed: a retry, a correction
// or an outcome is a new event that points at the old one (parent_id).
//
// Every event says who could see it:
//   visible_to         the roles (seats) whose prompts may include it
//   evaluator_visible  whether a judge or a researcher's export may include it
// so "what each agent knew" can be rebuilt from the record alone.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KINDS = ['run', 'session', 'call', 'reply', 'retry', 'error', 'budget', 'tool', 'outcome', 'note'];

const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
const sha256 = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');

class EventLog {
  /** @param {string} dir the run folder */
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'events.jsonl');
    this.payloads = path.join(dir, 'payloads');
    fs.mkdirSync(this.payloads, { recursive: true, mode: 0o700 });
  }

  /**
   * Keeps a text and returns its reference. The same text is stored once.
   * @param {string} text
   */
  put(text) {
    const h = sha256(text);
    const f = path.join(this.payloads, h + '.txt');
    if (!fs.existsSync(f)) {
      fs.writeFileSync(f + '.tmp', String(text), { mode: 0o600 });
      fs.renameSync(f + '.tmp', f);
    }
    return 'sha256:' + h;
  }

  /** @param {string} ref */
  get(ref) {
    const h = String(ref).replace(/^sha256:/, '');
    if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`not a payload reference: ${ref}`);
    return fs.readFileSync(path.join(this.payloads, h + '.txt'), 'utf8');
  }

  /**
   * Appends one event and returns it with its id and time.
   * @param {{ kind: string, session_id?: string|null, attempt_id?: string|null, parent_id?: string|null, role?: string|null,
   *           visible_to?: string[], evaluator_visible?: boolean, [k: string]: any }} ev
   */
  append(ev) {
    if (!KINDS.includes(ev.kind)) throw new Error(`event kind "${ev.kind}" is not one of ${KINDS.join(', ')}`);
    if (!Array.isArray(ev.visible_to)) throw new Error('event needs visible_to (an empty list if no agent sees it)');
    if (typeof ev.evaluator_visible !== 'boolean') throw new Error('event needs evaluator_visible: true or false');
    const row = { event_id: newId('ev'), at: new Date().toISOString(), session_id: null, attempt_id: null, parent_id: null, role: null, ...ev };
    fs.appendFileSync(this.file, JSON.stringify(row) + '\n', { mode: 0o600 });
    return row;
  }

  /** Every event so far, in order. A half-written last line (a crash mid-write) is skipped. */
  all() {
    if (!fs.existsSync(this.file)) return [];
    const out = [];
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
    return out;
  }
}

module.exports = { EventLog, newId, sha256 };
