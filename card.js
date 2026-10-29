#!/usr/bin/env node
// A quote card per episode: the line said in the room over the line written
// alone, as a 1080×1350 PNG for social posts, with its alt text and the words
// of the post. Nothing here posts anything.
//
// season.js makes one after each day. By hand, for an episode file season.js
// wrote: `node card.js <day-n.md> [--url <episode url>]`, which writes
// day-n.png and day-n.card.json beside it.

const fs   = require('fs');
const path = require('path');

const W = 1080, H = 1350;

// The site's colours: amber for Claude, cobalt for Antigravity, day then night.
const DAY   = { bg: '#eceee9', ink: '#16191a', muted: '#576059' };
const NIGHT = { bg: '#161b2b', ink: '#e9ebe4', muted: '#9fa6a8', rule: '#343b52' };
const ACCENT = { claude: ['#8f5a00', '#f2b54e'], antigravity: ['#2a4fc0', '#93acff'] };
const SPARE = [['#8f5a00', '#f2b54e'], ['#2a4fc0', '#93acff']];
// The show's marks: Claude is a comma, low on the line; Antigravity is a prime, high above it.
// Same paths as the site's assets/marks/. [viewBox, path]
const MARK = {
  claude: ['31 39 38 63', '<circle cx="50" cy="58" r="18"/><path d="M66 66C66 84 56 94 38 100C48 90 52 82 52 76Z"/>'],
  antigravity: ['39 3 28 48', '<path d="M46 4h19a3 3 0 0 1 2.9 3.9L53.4 49a3 3 0 0 1-5.8-.6L43 7.4A3 3 0 0 1 46 4Z"/>'],
};
const mark = (k, fill, cls) => MARK[k] ? `<svg class="${cls}" viewBox="${MARK[k][0]}" fill="${fill}" aria-hidden="true">${MARK[k][1]}</svg>` : '';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Long lines get smaller type, so every teaser fits its half of the card.
const size = text => { const n = text.length; return n <= 70 ? 66 : n <= 130 ? 54 : n <= 200 ? 46 : n <= 300 ? 38 : 32; };

// front: an episode's front matter (season, day, title, thread, models).
// names: { key: display name }. url: the episode's page, if known.
function cardFor(front, { names = {}, url } = {}) {
  const thread = [...(front.thread || [])].sort((a, b) => (a.from === 'journal') - (b.from === 'journal'));
  if (thread.length !== 2) throw new Error('The episode has no two-line teaser.');
  const keys = Object.keys(front.models || {});
  const name = k => names[k] || k;
  const accent = (k, night) => (ACCENT[k] || SPARE[Math.max(0, keys.indexOf(k)) % 2])[night ? 1 : 0];
  const label = t => t.from === 'journal' ? `That night, ${name(t.by)} wrote` : `In the room, ${name(t.by)} said`;
  const where = `Season ${front.season}, day ${front.day}`;
  const models = keys.map(k => `${name(k)}: ${front.models[k]}`).join(' · ');

  const half = (t, night) => `
  <section class="${night ? 'night' : 'day'}">
    <p class="label" style="color:${accent(t.by, night)}">${mark(t.by, accent(t.by, night), `mark mark-${t.by}`)}${esc(label(t))}</p>
    <blockquote style="font-size:${size(t.text)}px">${esc(t.text)}</blockquote>
  </section>`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@500;600&family=Instrument+Serif&display=block">
<style>
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${W}px; height: ${H}px; overflow: hidden; }
  body { display: flex; flex-direction: column; font-family: "Instrument Sans", system-ui, sans-serif; }
  section { flex: 1; display: flex; flex-direction: column; justify-content: center; padding: 72px 88px; }
  .day { background: ${DAY.bg}; color: ${DAY.ink}; }
  .night { background: ${NIGHT.bg}; color: ${NIGHT.ink}; }
  .label { font-size: 28px; font-weight: 600; letter-spacing: .02em; margin-bottom: 28px; display: flex; gap: 16px; }
  .mark { flex: none; height: 40px; } .mark-claude { width: 24px; align-self: flex-end; } .mark-antigravity { width: 24px; height: 34px; align-self: flex-start; }
  .pair { height: 22px; vertical-align: -3px; margin-right: 10px; }
  blockquote { font-family: "Instrument Serif", Georgia, serif; line-height: 1.15; }
  blockquote::before { content: "\\201C"; } blockquote::after { content: "\\201D"; }
  footer { background: ${NIGHT.bg}; color: ${NIGHT.muted}; border-top: 1px solid ${NIGHT.rule}; padding: 28px 88px 40px; font-size: 22px; line-height: 1.5; }
  footer strong { color: ${NIGHT.ink}; font-weight: 600; }
</style></head>
<body>${half(thread[0], false)}${half(thread[1], true)}
  <footer>
    <p><svg class="pair" viewBox="28 0 82 104" aria-hidden="true"><g fill="${ACCENT.claude[1]}">${MARK.claude[1]}</g><g fill="${ACCENT.antigravity[1]}" transform="translate(40 0)">${MARK.antigravity[1]}</g></svg><strong>The Second Room</strong> · ${esc(where)} · ${esc(front.title || '')}</p>
    ${url ? `<p>${esc(url.replace(/^https?:\/\//, ''))}</p>` : ''}
    ${models ? `<p>${esc(models)}</p>` : ''}
  </footer>
</body></html>`;

  const alt = [`The Second Room, ${where.toLowerCase()}: ${front.title || ''}.`,
    ...thread.map(t => `${label(t)}: “${t.text}”`)].join(' ');
  const post = [`The Second Room, ${where.toLowerCase()}: ${front.title || ''}`, url].filter(Boolean).join('\n\n');
  return { html, alt, post };
}

// The page runs no script and fetches nothing but the site's two fonts.
async function renderCard(html, file, launchOptions = {}) {
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch(launchOptions);
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, javaScriptEnabled: false });
    await page.route('**/*', r => /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(r.request().url()) ? r.continue() : r.abort());
    // Offline, the fonts don't come and the card falls back to Georgia and the system sans.
    await page.setContent(html, { waitUntil: 'load', timeout: 15000 }).catch(() => {});
    await page.evaluate(() => document.fonts.ready).catch(() => {});
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: W, height: H } });
  } finally {
    await browser.close();
  }
}

// ---- By hand, from an episode file season.js wrote ----

// Only what the card needs, from the front matter season.js writes: one-line
// values are JSON strings or numbers.
function readEpisode(text) {
  const fm = (text.match(/^---\n([\s\S]*?)\n---/) || [])[1];
  if (!fm) throw new Error('No front matter.');
  const val = v => { try { return JSON.parse(v); } catch { return v.trim(); } };
  const top = k => { const m = fm.match(new RegExp(`^${k}: (.+)$`, 'm')); return m ? val(m[1]) : undefined; };
  const block = k => (fm.match(new RegExp(`^${k}:\\n((?:  .*\\n?)*)`, 'm')) || [])[1] || '';
  const models = Object.fromEntries([...block('models').matchAll(/^  (\w+): (.+)$/gm)].map(m => [m[1], val(m[2])]));
  const thread = block('thread').split(/^  - /m).slice(1).map(item =>
    Object.fromEntries([...item.matchAll(/^(?:    )?(from|by|text): (.+)$/gm)].map(m => [m[1], val(m[2])])));
  return { season: top('season'), day: top('day'), title: top('title'), models, thread };
}

async function main() {
  const argv = process.argv.slice(2);
  const file = argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--url');
  if (!file) { console.error('usage: node card.js <day-n.md> [--url <episode url>]'); process.exit(2); }
  const url = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : undefined;
  const front = readEpisode(fs.readFileSync(file, 'utf8'));
  const keys = [...Object.keys(front.models), ...front.thread.map(t => t.by)].filter(Boolean);
  const names = Object.fromEntries(keys.map(k => [k, k[0].toUpperCase() + k.slice(1)]));
  const c = cardFor(front, { names, url });
  const base = file.replace(/\.md$/, '');
  await renderCard(c.html, `${base}.png`);
  fs.writeFileSync(`${base}.card.json`, JSON.stringify({ png: path.basename(`${base}.png`), alt: c.alt, post: c.post }, null, 2));
  console.log(`Card: ${base}.png`);
}

if (require.main === module) main().catch(e => { console.error(`card: ${e.message}`); process.exit(1); });

module.exports = { cardFor, renderCard, readEpisode };
