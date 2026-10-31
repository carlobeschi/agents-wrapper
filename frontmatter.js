// Writing an episode for a Jekyll show site: YAML front matter, and agent text
// made safe for kramdown. Shared by season.js and motion.js.

// The site renders every text with kramdown, which would pass HTML, links and
// its own {: } syntax straight to the page. Agent text is escaped so that none
// of that runs: no tags, no links, no images, no attribute lists. Code blocks
// are left alone; kramdown shows them as text.
function inertForSite(text) {
  let fenced = false;
  return String(text).split('\n').map(l => {
    if (/^\s*(```|~~~)/.test(l)) { fenced = !fenced; return l; }
    // Inside an inline code span a backslash shows as it is, and the span is already inert.
    return fenced ? l : l.split(/(`+[^`]*`+)/).map((part, i) => i % 2 ? part : part.replace(/([<\[{])/g, '\\$1')).join('');
  }).join('\n');
}

// The title and the teaser are put on the page as they are, not as Markdown.
const plain = text => String(text).replace(/[<>]/g, '');

// ---- YAML front matter ----

// Strings as JSON (valid YAML) when short, as a block scalar when they have lines.
function yamlString(s, indent) {
  s = String(s).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '');
  if (!s.includes('\n') || /^\s/.test(s)) return JSON.stringify(s);
  const pad = ' '.repeat(indent);
  return '|\n' + s.split('\n').map(l => (l ? pad + l : '')).join('\n');
}

function yaml(v, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    return v.map(item => {
      const body = yaml(item, indent + 2).replace(/^\s+/, '');
      return `${pad}- ${body}`;
    }).join('\n');
  }
  return Object.entries(v).filter(([, x]) => x !== undefined && x !== null).map(([k, x]) => {
    if (typeof x === 'object') return `${pad}${k}:\n${yaml(x, indent + 2)}`;
    if (typeof x === 'number' || typeof x === 'boolean') return `${pad}${k}: ${x}`;
    return `${pad}${k}: ${yamlString(x, indent + 2)}`;
  }).join('\n');
}

// Reads back what yaml() writes: maps, lists of maps, JSON strings, block
// scalars, numbers and booleans. Not a general YAML parser.
function unyaml(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const ind = l => l.match(/^ */)[0].length;
  const item = (l, n) => ind(l) === n && l.slice(n).startsWith('- ');
  let i = 0;
  const scalar = s => s === 'true' ? true : s === 'false' ? false
    : /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s.startsWith('"') ? JSON.parse(s) : s;
  function value(rest, n) {
    if (rest === '|') {
      const out = [];
      while (i < lines.length && (lines[i] === '' || ind(lines[i]) >= n + 2)) out.push(lines[i++].slice(n + 2));
      return out.join('\n').replace(/\n+$/, '');
    }
    return rest ? scalar(rest) : node(n + 2);
  }
  function node(n) {
    if (!(i < lines.length && item(lines[i], n))) return map(n);
    const list = [];
    while (i < lines.length && item(lines[i], n)) {
      lines[i] = ' '.repeat(n + 2) + lines[i].slice(n + 2);
      list.push(map(n + 2));
    }
    return list;
  }
  function map(n) {
    const o = {};
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      if (ind(l) !== n || item(l, n)) break;
      const m = l.slice(n).match(/^([^:]+):(?: (.*))?$/);
      if (!m) throw new Error(`Can't read line ${i + 1}: ${l}`);
      i++;
      o[m[1]] = value(m[2] || '', n);
    }
    return o;
  }
  return map(0);
}

// Undoes inertForSite, for agent text read back from an episode file.
const uninert = text => String(text).replace(/\\([<\[{])/g, '$1');

module.exports = { inertForSite, plain, yaml, unyaml, uninert };
