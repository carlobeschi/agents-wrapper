#!/usr/bin/env node
// @ts-check
// A wide card and a short post for Ko-fi, for one episode of any show on the
// studio site: The Motion, The Trap or Twelve Shapes. 1200×630, because Ko-fi's
// feed crops tall images. Nothing here posts anything.
//
// `node kofi-card.js <episode.md> [--site <studio url>]` writes <episode>.kofi.png
// and <episode>.kofi.txt beside it (the post's text, card's alt on the last line).
// The show comes from the folder: _episodes (The Motion), _traps, _shapes.

const fs   = require('fs');
const path = require('path');
const { renderCard } = require('./card');
const { unyaml } = require('./frontmatter');

const W = 1200, H = 630;
const NAME = { claude: 'Claude', antigravity: 'Gemini', codex: 'Codex' };
const COLOUR = { claude: '#d97757', antigravity: '#2a4fc0', codex: '#2f5a46' };
const MODEL = { 'claude-opus-5-5': 'Claude Opus 5.5', 'gemini-4-argon-medium': 'Gemini 4 Argon', 'gpt-6-luna': 'GPT-6 Luna' };
const STUDIO_MARK = '<svg viewBox="28 0 82 104"><g fill="#d97757"><circle cx="50" cy="58" r="18"/><path d="M66 66C66 84 56 94 38 100C48 90 52 82 52 76Z"/></g><g transform="translate(40 0)" fill="#2a4fc0"><path d="M46 4h19a3 3 0 0 1 2.9 3.9L53.4 49a3 3 0 0 1-5.8-.6L43 7.4A3 3 0 0 1 46 4Z"/></g></svg>';
const SHOW = { _episodes: 'motion', _traps: 'trap', _shapes: 'shapes' };
const TITLE = { motion: 'The Motion', trap: 'The Trap', shapes: 'Twelve Shapes' };

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fit = (n, sizes) => sizes.find(([max]) => n <= max)?.[1] ?? sizes[sizes.length - 1][1];
const name = k => NAME[k] || k;
const models = f => Object.values(f.models || {}).map(id => MODEL[id] || id).join(' · ');
const score = f => Object.entries(f.score || {}).sort((a, b) => b[1] - a[1]);

function page(show, label, left, right, foot) {
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Spectral:ital,wght@0,600;1,400&family=IBM+Plex+Sans:wght@600&family=IBM+Plex+Mono:wght@500&display=swap">
<style>
*{box-sizing:border-box;margin:0}
html,body{width:${W}px;height:${H}px;overflow:hidden}
body{background:#f2f1ec;color:#191c1b;font-family:"IBM Plex Sans",sans-serif}
.frame{position:absolute;inset:0;padding:52px 60px;display:grid;grid-template-rows:auto 1fr auto;gap:28px}
.top{display:flex;align-items:center;justify-content:space-between;font:500 19px "IBM Plex Mono",monospace;letter-spacing:.1em;text-transform:uppercase;color:#5c6360}
.brand{display:flex;align-items:center;gap:12px;color:#191c1b;font:600 28px Spectral,serif;letter-spacing:0;text-transform:none}
.brand svg{width:30px;height:38px}
.body{display:grid;grid-template-columns:1fr 1fr;gap:52px;align-items:center;min-height:0;overflow:hidden}
.kick{font:500 18px "IBM Plex Mono",monospace;letter-spacing:.1em;text-transform:uppercase;color:#2f5a46;margin-bottom:12px}
h1{font:600 var(--h,44px)/1.14 Spectral,serif;text-wrap:balance}
blockquote{border-left:7px solid var(--c);padding:4px 0 4px 28px;display:grid;gap:18px}
blockquote p{font:italic 400 var(--q,34px)/1.3 Spectral,serif;text-wrap:balance}
cite{font:500 17px "IBM Plex Mono",monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--c);font-style:normal}
.art{height:380px;display:flex;justify-content:center}
.art svg{height:100%;width:auto;border-radius:6px;background:#fff}
.scores{display:grid;gap:14px}
.scores div{display:flex;align-items:baseline;justify-content:space-between;border-bottom:1px solid #d6d4cc;padding-bottom:10px;font:600 34px Spectral,serif}
.scores b{font:500 40px "IBM Plex Mono",monospace;color:var(--c)}
.foot{display:flex;justify-content:space-between;font:500 18px "IBM Plex Mono",monospace;color:#5c6360}
.foot span:first-child{color:#191c1b}
</style></head><body><div class="frame">
<div class="top"><div class="brand">${STUDIO_MARK}${esc(TITLE[show])}</div><span>${esc(label)}</span></div>
<div class="body"><div>${left}</div><div>${right}</div></div>
<div class="foot"><span>${esc(foot[0])}</span><span>${esc(foot[1])}</span></div>
</div></body></html>`;
}

// The drawing with the most to say: an idea that split the two guessers, else any idea, else the first.
function pickDrawing(f) {
  const ds = f.drawings || [];
  const split = d => { const r = (d.guesses || []).filter(g => g.right).length; return r > 0 && r < (d.guesses || []).length; };
  return ds.find(d => d.kind === 'ideas' && split(d)) || ds.find(d => d.kind === 'ideas') || ds[0];
}

// front: the episode's front matter. show: motion, trap or shapes. site: the studio's address, no slash at the end.
function kofiCardFor(front, show, { site = '' } = {}) {
  const host = site.replace(/^https?:\/\//, '');
  const n = front.number;
  if (show === 'motion') {
    const q = front.quote;
    if (!q) throw new Error('The episode has no quote.');
    const where = q.where === 'debate' ? 'in the debate' : q.where === 'before' ? 'before the debate, alone' : `after arguing ${front.sides?.[q.by]}, alone`;
    const url = `${site}/motion-${n}.html`;
    const html = page(show, `Motion ${n}`,
      `<div class="kick">This house believes</div><h1 style="--h:${fit(front.motion.length, [[70, 50], [120, 44], [180, 38]])}px">${esc(front.motion)}</h1>`,
      `<blockquote style="--c:${COLOUR[q.by]};--q:${fit(q.text.length, [[90, 36], [160, 31], [240, 26]])}px"><p>“${esc(q.text)}”</p><cite>${esc(name(q.by))} · ${esc(where)}</cite></blockquote>`,
      [models(front), `${host}/motion/`]);
    const text = [`Motion ${n}: this house believes ${front.motion}`, '',
      `${name(q.by)}, ${where}: "${q.text}"`, '', `Full debate: ${url}`];
    return { html, text: text.join('\n'), alt: `The Motion, Motion ${n}. This house believes ${front.motion} ${name(q.by)}, ${where}: "${q.text}"`, url };
  }
  if (show === 'shapes') {
    const d = pickDrawing(front);
    if (!d) throw new Error('The episode has no drawings.');
    const gs = (d.guesses || []).map(g => g.right ? `${name(g.by)} got it` : `${name(g.by)} guessed “${g.answer}”`);
    const url = `${site}/shapes/episode-${n}.html`;
    const line = `${name(d.by)} drew “${d.word}” in ${d.count} shapes. ${gs.join('; ')}.`;
    const html = page(show, `Episode ${n}`,
      `<div class="kick">Round ${esc(d.round)} · ${esc(d.kind)}</div><h1 style="--h:40px">${esc(line)}</h1>`,
      `<div class="art">${d.svg}</div>`,
      [models(front), `${host}/shapes/`]);
    const text = [`Twelve Shapes, episode ${n}: each agent draws a secret word in twelve shapes, and the other two see only the code.`, '',
      line, '', `Score: ${score(front).map(([k, v]) => `${name(k)} ${v}`).join(', ')}`, '', `All the drawings: ${url}`];
    return { html, text: text.join('\n'), alt: `Twelve Shapes, episode ${n}. ${line}`, url };
  }
  if (show === 'trap') {
    const s = score(front);
    if (!s.length) throw new Error('The episode has no score.');
    const url = `${site}/trap/episode-${n}.html`;
    const html = page(show, `Episode ${n}`,
      `<div class="kick">Three agents, three puzzles</div><h1 style="--h:42px">Each set the others one puzzle, hoping they get it wrong.</h1>`,
      `<div class="scores">${s.map(([k, v]) => `<div style="--c:${COLOUR[k] || '#5c6360'}">${esc(name(k))}<b>${esc(v)}</b></div>`).join('')}</div>`,
      [models(front), `${host}/trap/`]);
    const text = [`The Trap, episode ${n}: Claude, Gemini and Codex each set the others one puzzle, hoping they get it wrong. The app checks every answer.`, '',
      `Score: ${s.map(([k, v]) => `${name(k)} ${v}`).join(', ')}`, '', `Puzzles, answers and working: ${url}`];
    return { html, text: text.join('\n'), alt: `The Trap, episode ${n}. Score: ${s.map(([k, v]) => `${name(k)} ${v}`).join(', ')}`, url };
  }
  throw new Error(`Unknown show: ${show}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const file = argv.find(a => a.endsWith('.md'));
  if (!file) { console.error('usage: node kofi-card.js <episode.md> [--site <studio url>]'); process.exit(2); }
  const site = (argv.includes('--site') ? argv[argv.indexOf('--site') + 1] : 'https://carlobeschi.github.io/model-behaviour').replace(/\/$/, '');
  const show = SHOW[path.basename(path.dirname(path.resolve(file)))];
  if (!show) throw new Error('The file is not in _episodes, _traps or _shapes.');
  const front = unyaml((fs.readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/) || [])[1] || '');
  const c = kofiCardFor(front, show, { site });
  const out = path.join(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.dirname(file), path.basename(file, '.md'));
  await renderCard(c.html, `${out}.kofi.png`, process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}, { width: W, height: H });
  fs.writeFileSync(`${out}.kofi.txt`, `${c.text}\n\nAlt: ${c.alt}\n`);
  console.log(`Card: ${out}.kofi.png`);
}

if (require.main === module) main().catch(e => { console.error(`kofi-card: ${e.message}`); process.exit(1); });

module.exports = { kofiCardFor, pickDrawing };
