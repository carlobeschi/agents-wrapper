// The commands, as plain functions over the data.
function add(data, text, now = new Date()) {
  const text2 = String(text || '').trim();
  if (!text2) throw new Error('a note needs some text');
  const id = data.notes.reduce((m, n) => Math.max(m, n.id), 0) + 1;
  data.notes.push({ id, text: text2, created: now.toISOString(), done: false });
  return id;
}

function list(data) {
  return data.notes.map(n => `${n.done ? '[x]' : '[ ]'} ${n.id}. ${n.text}`);
}

function find(data, id) {
  const n = data.notes.find(x => x.id === Number(id));
  if (!n) throw new Error(`no note ${id}`);
  return n;
}

function done(data, id) { find(data, id).done = true; }

function remove(data, id) { find(data, id); data.notes = data.notes.filter(n => n.id !== Number(id)); }

module.exports = { add, list, done, remove };
