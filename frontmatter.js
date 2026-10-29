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
    return fenced ? l : l.replace(/([<\[{])/g, '\\$1');
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

module.exports = { inertForSite, plain, yaml };
