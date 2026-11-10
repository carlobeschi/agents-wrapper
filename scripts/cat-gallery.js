#!/usr/bin/env node
// Builds one self-contained HTML page with every drawing the solo-vs-together
// studies made (study.js), grouped by study, task and arm, with each judge's
// score. Read-only: it only reads ~/.agent-dispatch/studies/*/study.json and
// the final.svg of each room run, and writes one HTML file.
//
//   node scripts/cat-gallery.js [out.html] [--task cat]
//
// A study still running shows what it has saved so far; pieces not judged yet
// say so. Drawings are embedded as <img> data URLs, so nothing in them runs.

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.AGENT_DISPATCH_HOME || path.join(os.homedir(), '.agent-dispatch');
const args = process.argv.slice(2);
const ti = args.indexOf('--task');
const onlyTask = ti >= 0 ? args.splice(ti, 2)[1] : null;
const out = args[0] || path.join(HOME, 'cat-gallery.html');

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mean = xs => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 10) / 10 : null;
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

const root = path.join(HOME, 'studies');
const runs = fs.existsSync(root) ? fs.readdirSync(root).sort() : [];
const studies = [];
for (const name of runs) {
  const s = (() => { try { return JSON.parse(read(path.join(root, name, 'study.json'))); } catch { return null; } })();
  if (!s) continue;
  const tasks = [];
  for (const t of s.tasks || []) {
    if (t.kind !== 'svg' || (onlyTask && t.id !== onlyTask)) continue;
    const arms = {};
    (t.repeats || []).forEach((rep, r) => {
      for (const [label, run] of Object.entries(rep.runs || {})) {
        const pieces = [];
        const add = (dir, note) => { const svg = dir && read(path.join(dir, 'final.svg')); if (svg) pieces.push({ svg, note }); };
        if (run.tournament) {
          // Tournament arm: the judged piece is the winning revision; drafts and the losing revision shown too.
          add(run.dir, `versione scelta (${run.tournament.winner})`);
          for (const [i, d] of (run.tournament.drafts || []).entries()) {
            add(d.dir, `bozza ${i + 1} di ${run.tournament.generators?.[i] || '?'}`);
            if (d.revision !== run.dir) add(d.revision, `revisione ${i + 1} scartata`);
          }
        } else add(run.dir, null);
        if (!pieces.length) continue;
        const scores = (rep.judgings || []).flatMap(j => (j.pieces || []).filter(p => p.label === label)
          .map(p => ({ judge: j.judge, score: p.score, reason: p.reason, best: j.best === label })));
        (arms[label] ||= []).push({ repeat: r + 1, pieces, scores, guess: run.guess, starter: run.starter || null, seconds: run.seconds });
      }
    });
    if (Object.keys(arms).length) tasks.push({ id: t.id, brief: t.brief, average: t.average || {}, best: t.best || {}, arms });
  }
  if (tasks.length) studies.push({ name, title: s.title || name, agents: (s.agents || []).map(a => a.label || a.id), judges: s.judges || [], tasks });
}

const b64 = svg => 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
const judgeName = j => ({ claude: 'Claude', codex: 'Codex', antigravity: 'Gemini' }[j] || j);
let n = 0;
const body = studies.map(s => `
<section><h2>${esc(s.title)}</h2>
<p class="meta">Cartella ${esc(s.name)} · agenti: ${esc(s.agents.join(', '))} · giudici: ${esc(s.judges.map(judgeName).join(', '))}</p>
${s.tasks.map(t => `<h3>Compito: ${esc(t.id)}</h3>${t.brief ? `<p class="brief">${esc(t.brief)}</p>` : ''}
${Object.entries(t.arms).map(([label, reps]) => `<div class="arm"><h4>${esc(label)}${t.average[label] != null ? ` <span class="avg">media ${esc(t.average[label])}</span>` : ''}${t.best[label] ? ` <span class="best">migliore ×${esc(t.best[label])}</span>` : ''}</h4>
<div class="grid">${reps.flatMap(rep => rep.pieces.map(p => { n++; const sc = rep.scores.filter(x => x.score != null);
  return `<figure><img src="${b64(p.svg)}" alt="${esc(label)}, ripetizione ${rep.repeat}" loading="lazy"><figcaption>
<b>Rip. ${rep.repeat}</b>${p.note ? ` · ${esc(p.note)}` : ''}${rep.starter ? ` · inizia ${esc(rep.starter)}` : ''}<br>
${p.note && !p.note.startsWith('versione scelta') ? '<span class="dim">non giudicata (bozza interna)</span>' : sc.length ? `voto ${mean(sc.map(x => x.score))} <span class="dim">(${sc.map(x => `${esc(judgeName(x.judge))} ${esc(x.score)}${x.best ? '★' : ''}`).join(' · ')})</span>` : '<span class="dim">non ancora giudicata</span>'}
${rep.guess ? `<br>indovinato ${esc(rep.guess)}` : ''}
${sc.length && !(p.note && !p.note.startsWith('versione scelta')) ? `<details><summary>motivi dei giudici</summary>${sc.map(x => `<p><b>${esc(judgeName(x.judge))}:</b> ${esc(x.reason)}</p>`).join('')}</details>` : ''}
</figcaption></figure>`; })).join('')}</div></div>`).join('')}`).join('')}
</section>`).join('');

const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Galleria dei disegni</title><style>
body{font:15px/1.45 system-ui,sans-serif;margin:0 auto;max-width:1200px;padding:16px;background:#faf9f5;color:#1f1e1d}
h2{margin-top:2.5em;border-bottom:2px solid #d97757}h4{margin:1.2em 0 .4em}.meta,.brief,.dim{color:#6b6a66}.brief{font-size:13px}
.avg{background:#d97757;color:#fff;border-radius:4px;padding:1px 6px;font-size:13px}.best{font-size:13px;color:#a0522d}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
figure{margin:0;background:#fff;border:1px solid #e5e2d9;border-radius:8px;padding:8px}img{width:100%;aspect-ratio:1;object-fit:contain;background:#fff}
figcaption{font-size:13px}details p{margin:.3em 0}
</style></head><body><h1>Galleria dei disegni degli studi</h1>
<p class="meta">${n} disegni da ${studies.length} studi. Voti 1-10 dei giudici ciechi; ★ = scelto come migliore del suo gruppo da quel giudice. Generato ${new Date().toISOString().slice(0, 16).replace('T', ' ')}.</p>
${body || '<p>Nessun disegno trovato.</p>'}</body></html>`;

fs.writeFileSync(out, html);
console.log(`${n} disegni da ${studies.length} studi -> ${out}`);
