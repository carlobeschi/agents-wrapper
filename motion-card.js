#!/usr/bin/env node
// A LinkedIn card for an episode of The Motion: the question in large type,
// who argued which side, and whether arguing changed each one's mind, as a
// 1080×1350 PNG, in the site's colours. The editor's quote goes in the post. The footer points at the show's
// home, <site>/motion/. Nothing here posts anything.
//
// motion-daily.js makes one after each run. By hand, for an episode file:
// `node motion-card.js <motion-n.md> [--site <show url>]`, which writes
// motion-n.png beside it.

const fs   = require('fs');
const { renderCard } = require('./card');
const { unyaml } = require('./frontmatter');

const COLOUR = { claude: ['#d97757', '#a9512c'], antigravity: ['#2a4fc0', '#2a4fc0'] };
const NAME = { claude: 'Claude', antigravity: 'Gemini' };
// The show's marks: Claude is a comma, low on the line; Gemini is a prime, high above it.
const MARK = {
  claude: ['31 39 38 63', '<circle cx="50" cy="58" r="18"/><path d="M66 66C66 84 56 94 38 100C48 90 52 82 52 76Z"/>'],
  antigravity: ['42 3 28 49', '<path d="M46 4h19a3 3 0 0 1 2.9 3.9L53.4 49a3 3 0 0 1-5.8-.6L43 7.4A3 3 0 0 1 46 4Z"/>'],
};
const mark = k => MARK[k] ? `<svg viewBox="${MARK[k][0]}" fill="${COLOUR[k][0]}">${MARK[k][1]}</svg>` : '';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const WHERE = { debate: 'in the debate', before: 'before the debate, alone' };

// Long motions and quotes get smaller type, so the card never overflows.
const fit = (n, sizes) => sizes.find(([max]) => n <= max)?.[1] ?? sizes[sizes.length - 1][1];

// front: the episode's front matter. site: the show's address, without a slash at the end.
const SIDE = { for: 'for', against: 'against' }, ANSWER = { for: 'yes', against: 'no' };
const CHANGED = { them: 'yes', own: 'yes, toward its own side', none: 'barely' };

function motionCardFor(front, { site } = {}) {
  const q = front.quote;
  if (!q) throw new Error('The episode has no quote.');
  const where = WHERE[q.where] || `after arguing ${front.sides?.[q.by]}, alone`;
  const url = site ? `${site}/motion-${front.number}.html` : '';
  const head = front.question || `This house believes ${front.motion}`;
  const keys = Object.keys(front.sides || {});
  const label = front.question ? ANSWER : SIDE;
  const sides = keys.map(k => `<div class="side"><span class="who" style="color:${(COLOUR[k] || ['#191c1b'])[0]}">${mark(k)}${esc(NAME[k] || k)}</span><b>argues ${esc(label[front.sides[k]] || front.sides[k])}</b></div>`).join('');
  const mv = front.moved || {};
  const changed = keys.filter(k => mv[k] && CHANGED[mv[k].way]).map(k => `${NAME[k] || k}: ${CHANGED[mv[k].way]}`);
  const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Spectral:ital,wght@0,600;1,400&family=IBM+Plex+Sans:wght@600&family=IBM+Plex+Mono:wght@500&display=swap">
<style>
*{box-sizing:border-box;margin:0}
body{width:1080px;height:1350px;background:#f2f1ec;color:#191c1b;font-family:"IBM Plex Sans",sans-serif}
.frame{position:absolute;inset:0;padding:72px;display:flex;flex-direction:column;gap:56px}
.top{display:flex;align-items:center;justify-content:space-between;font:500 22px "IBM Plex Mono",monospace;letter-spacing:.1em;text-transform:uppercase;color:#5c6360}
.brand{display:flex;align-items:center;gap:14px;color:#191c1b;font:600 30px Spectral,serif;letter-spacing:0;text-transform:none}
.brand svg{width:34px;height:44px}
h1{margin:auto 0 0;font:600 ${fit(head.length, [[60, 80], [100, 68], [150, 58], [220, 50]])}px/1.1 Spectral,serif;text-wrap:balance}
.sides{display:flex;gap:28px}
.side{flex:1;border-top:4px solid #191c1b;padding-top:18px;display:flex;justify-content:space-between;align-items:center}
.who{display:flex;align-items:center;gap:12px;font:600 34px "IBM Plex Sans",sans-serif}
.who svg{height:40px;width:auto}
.side b{font:500 26px "IBM Plex Mono",monospace;letter-spacing:.08em;text-transform:uppercase;color:#5c6360}
.changed{font:400 40px/1.3 Spectral,serif;margin-bottom:auto}
.changed b{font-weight:600}
.foot{display:flex;justify-content:flex-end;font:500 21px "IBM Plex Mono",monospace;color:#5c6360}
</style></head><body><div class="frame">
<div class="top"><div class="brand"><svg viewBox="28 0 82 104"><g fill="#d97757">${MARK.claude[1]}</g><g transform="translate(40 0)" fill="#2a4fc0">${MARK.antigravity[1]}</g></svg>The Motion</div><span>Motion ${esc(front.number)}</span></div>
<h1>${esc(head)}</h1>
<div class="sides">${sides}</div>
${changed.length ? `<p class="changed"><b>Did arguing change their mind?</b> ${esc(changed.join('. '))}.</p>` : '<p class="changed"></p>'}
<div class="foot"><span>${esc(site ? `${site.replace(/^https?:\/\//, '')}/motion/` : '')}</span></div>
</div></body></html>`;
  const sidesText = keys.map(k => `${NAME[k] || k} argued ${label[front.sides[k]] || front.sides[k]}`).join(', ');
  const alt = `The Motion, Motion ${front.number}. ${head} ${sidesText}.${changed.length ? ` Did arguing change their mind? ${changed.join('. ')}.` : ''}`;
  const post = [
    front.question ? `Two AI models from rival labs debated a question from this week's news: ${front.question}` : `Two AI models from rival labs debated a motion from this week's news: this house believes ${front.motion}`, '',
    `Each was given a side. Before and after the debate, each wrote alone where it really stood, and the other never saw it.`, '',
    ...(front.summary ? [front.summary, ''] : []),
    `${NAME[q.by] || q.by}, ${where}: "${q.text}"`, '',
    ...(url ? [`Full debate, unedited: ${url}`, ''] : []),
    'Written by AI agents; I produce the show.',
  ].join('\n');
  return { html, alt, post, url };
}

async function main() {
  const argv = process.argv.slice(2);
  const file = argv.find(a => a.endsWith('.md'));
  if (!file) { console.error('usage: node motion-card.js <motion-n.md> [--site <show url>]'); process.exit(2); }
  const site = argv.includes('--site') ? argv[argv.indexOf('--site') + 1] : undefined;
  const front = unyaml((fs.readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/) || [])[1] || '');
  const c = motionCardFor(front, { site });
  const base = file.replace(/\.md$/, '');
  await renderCard(c.html, `${base}.png`);
  fs.writeFileSync(`${base}.post.md`, `${c.post}\n`);
  console.log(`Card: ${base}.png`);
}

if (require.main === module) main().catch(e => { console.error(`motion-card: ${e.message}`); process.exit(1); });

module.exports = { motionCardFor };
