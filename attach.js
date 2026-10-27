// Files the user attaches to an opener or a message.
//
// They are copied into a files/ folder inside the folder the agents run in, and
// the prompt lists them by relative path, so an agent reads them with its usual
// file tools: nothing about what an agent may do changes. The bounds are on what
// gets written: names the server picks, a short list of types, size caps, files
// that are never overwritten, and a folder that must be a real directory inside
// the conversation's own.

const fs   = require('fs');
const path = require('path');

const MAX_FILES = 5;                 // per message
const MAX_FILE  = 5 * 1024 * 1024;   // per file
const MAX_TOTAL = 20 * 1024 * 1024;  // per conversation
// A JSON body carrying MAX_FILES files in base64, with room for the text.
const MAX_BODY  = Math.ceil(MAX_TOTAL * 4 / 3) + 512 * 1024;

const TYPES = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'html', 'css', 'log',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'cs', 'php', 'sql', 'sh',
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp',
]);

// "../../x/My Report (v2).PDF" -> "My_Report_v2_.pdf". Basename only, a short
// character set, no leading dot, and an extension from TYPES.
function safeName(raw) {
  const base = String(raw ?? '').split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (!TYPES.has(ext)) return null;
  const stem = base.slice(0, dot).replace(/[^\w.-]+/g, '_').replace(/^[._-]+/, '').slice(0, 80) || 'file';
  return `${stem}.${ext}`;
}

const size = n => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

// body.files -> [{ name, buf }]. Throws a message for the user on anything off.
function parseFiles(files, used = 0) {
  if (files === undefined) return [];
  if (!Array.isArray(files)) throw new Error('Bad attachments.');
  if (files.length > MAX_FILES) throw new Error(`${MAX_FILES} files at most per message.`);
  let total = used;
  return files.map(f => {
    const name = safeName(f?.name);
    if (!name) throw new Error(`${String(f?.name ?? '').slice(0, 80) || 'A file'}: not a type that can be attached.`);
    if (typeof f.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data)) throw new Error(`${name}: bad data.`);
    const buf = Buffer.from(f.data, 'base64');
    if (buf.length > MAX_FILE) throw new Error(`${name}: ${size(MAX_FILE)} at most.`);
    total += buf.length;
    if (total > MAX_TOTAL) throw new Error(`${size(MAX_TOTAL)} of attachments at most per conversation.`);
    return { name, buf };
  });
}

// Write into <root>/files/, never following a link and never overwriting.
// Returns [{ path: 'files/x.pdf', size }].
function saveFiles(root, files) {
  if (!files.length) return [];
  const dir = path.join(root, 'files');
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(dir) !== path.join(fs.realpathSync(root), 'files')) {
    throw new Error('The files folder is not a plain folder; not writing to it.');
  }
  return files.map(({ name, buf }) => {
    const dot = name.lastIndexOf('.');
    for (let i = 1; i < 100; i++) {
      const n = i === 1 ? name : `${name.slice(0, dot)}-${i}${name.slice(dot)}`;
      let fd;
      // wx: O_CREAT|O_EXCL, which also refuses a link left at that name.
      try { fd = fs.openSync(path.join(dir, n), 'wx', 0o600); }
      catch (e) { if (e.code === 'EEXIST') continue; throw e; }
      try { fs.writeSync(fd, buf); } finally { fs.closeSync(fd); }
      return { path: `files/${n}`, size: buf.length };
    }
    throw new Error(`${name}: too many files with that name.`);
  });
}

// The line a prompt or transcript shows under a message with attachments.
const attachedLine = (files, where = 'in this folder') => files?.length
  ? `Attached (${where}): ${files.map(f => `${f.path} (${size(f.size)})`).join(', ')}`
  : '';

// A message's text with its attachments listed under it.
const withFiles = (text, files, where) => files?.length ? `${text}\n\n${attachedLine(files, where)}`.trim() : text;

const attachedBytes = items => items.reduce((n, m) => n + (m.files || []).reduce((k, f) => k + f.size, 0), 0);

module.exports = { parseFiles, saveFiles, attachedLine, withFiles, attachedBytes, safeName, MAX_BODY, MAX_FILES, MAX_FILE, TYPES };
