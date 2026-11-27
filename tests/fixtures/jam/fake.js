// A fake lab for jam.js: reads the prompt on stdin and answers by its shape.
// argv: <read|build> <name>. No model is called.
const fs = require('fs');
const [mode, name] = process.argv.slice(2);
let p = '';
process.stdin.on('data', c => { p += c; });
process.stdin.on('end', () => {
  if (mode === 'build') {
    const game = fs.readdirSync('.').find(f => f.endsWith('.html'));
    fs.appendFileSync(game, `\n<!-- ${name} built it -->\n`);
    if (name === 'a') fs.writeFileSync('extra.txt', 'x');
    return console.log(`WHAT I BUILT: both ideas, by ${name} (Claude).\nHOW TO SEE IT: tap the cat.\nNOT DONE: nothing`);
  }
  if (/Propose exactly/.test(p)) {
    return console.log([1, 2, 3].map(k => `**IDEA:** ${name} idea ${k}\nWHAT: the child taps\nand smiles ${k}.\nWHY: fun`).join('\n\n'));
  }
  if (/Score every idea/.test(p)) {
    const lines = p.split('\n').filter(l => /^I\d+\. /.test(l));
    // Each fake likes "idea 2" best, and "x idea 1" where x follows it.
    return console.log(lines.map(l => { const n = l.match(/^I(\d+)/)[1]; return `I${n}: ${/idea 2/.test(l) ? 9 : /idea 1/.test(l) ? 6 : 3} - ok`; }).join('\n'));
  }
  if (/score the others' work/.test(p)) {
    const letters = fs.readdirSync('.').filter(f => /^[A-Z]$/.test(f));
    const score = L => /a built it/.test(fs.readFileSync(`${L}/changes.diff`, 'utf8')) ? 8 : 5;
    return console.log(letters.map(L => `${L}: ${score(L)} - fine`).join('\n') + `\nBEST: ${letters[0]} - first`);
  }
  console.log('?');
});
