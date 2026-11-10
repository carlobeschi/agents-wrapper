#!/usr/bin/env node
// Checks that every landmark source and deep-dive link in fields/*.json still resolves.
// Run: node atlas/check-links.js [--json out.json]
// "broken" = 404/410 or the host does not exist. "blocked" = the site refuses scripts
// (401/403/429 and similar), which says nothing about whether the page exists.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const dir = path.join(__dirname, 'fields');
const links = [];
for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const f = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  for (const d of f.deepDives || []) links.push({ where: f.id, what: 'deep dive: ' + d.title, url: d.url });
  for (const r of f.regions) {
    for (const l of r.landmarks) if (l.source) links.push({ where: r.id, what: 'landmark: ' + l.name, url: l.source });
    for (const d of r.deepDives || []) links.push({ where: r.id, what: 'deep dive: ' + d.title, url: d.url });
  }
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
// curl is used because it honours the proxy and CA settings of managed environments.
const check = url => new Promise(resolve => {
  execFile('curl', ['-s', '-o', '/dev/null', '-L', '--max-redirs', '6', '-m', '25', '-A', UA, '-H', 'Accept: text/html,*/*', '-w', '%{http_code} %{url_effective}', url],
    (err, out) => { const [code, final] = String(out || '').split(' '); resolve({ code: Number(code) || 0, final, err: err ? err.code : 0 }); });
});

(async () => {
  const unique = [...new Set(links.map(l => l.url))], result = {};
  let i = 0;
  const worker = async () => { while (i < unique.length) { const u = unique[i++]; result[u] = await check(u); } };
  await Promise.all(Array.from({ length: 12 }, worker));
  const verdict = r => r.code >= 200 && r.code < 400 ? 'ok' : r.code === 404 || r.code === 410 || (r.code === 0 && r.err === 6) ? 'broken' : 'blocked';
  const rows = links.map(l => ({ ...l, ...result[l.url], verdict: verdict(result[l.url]) }));
  const count = v => rows.filter(r => r.verdict === v).length;
  console.log(`${rows.length} links (${unique.length} unique): ${count('ok')} ok, ${count('blocked')} blocked to scripts, ${count('broken')} broken`);
  for (const r of rows.filter(r => r.verdict === 'broken')) console.log(`BROKEN  ${r.code} ${r.where}  ${r.what}\n        ${r.url}`);
  for (const r of rows.filter(r => r.verdict === 'blocked')) console.log(`blocked ${r.code || 'err' + r.err} ${r.where}  ${r.url}`);
  const j = process.argv.indexOf('--json'); if (j > 0) fs.writeFileSync(process.argv[j + 1], JSON.stringify(rows, null, 1));
  process.exitCode = count('broken') ? 1 : 0;
})();
