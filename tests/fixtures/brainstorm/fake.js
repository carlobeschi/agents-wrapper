// A fake agent for the brainstorm app: reads the prompt on stdin and answers
// by its shape. argv: <read|build> <name>. No model is called.
const fs = require('fs');
const [mode, name] = process.argv.slice(2);
let p = '';
process.stdin.on('data', c => { p += c; });
process.stdin.on('end', () => {
  if (mode === 'build') {
    if (/hello\.txt/.test(p)) { fs.writeFileSync('hello.txt', 'hi'); return console.log('done'); }
    fs.writeFileSync(`plan-${name}.md`, `# ${name}\n`);
    fs.writeFileSync('BRAINSTORM.md', `built by ${name}\n`);
    return console.log(`WHAT I BUILT: a plan, by ${name} (Claude).\nHOW TO SEE IT: open plan-${name}.md\nNOT DONE: nothing`);
  }
  if (/word\.txt/.test(p)) return console.log(fs.readFileSync('word.txt', 'utf8'));
  if (/Propose exactly (\d+)/.test(p)) {
    const n = Number(/Propose exactly (\d+)/.exec(p)[1]);
    const seen = fs.existsSync('notes.md') ? ' (read notes.md)' : '';
    return console.log(Array.from({ length: n }, (_, k) => `IDEA: ${name} idea ${k + 1}${seen}\nWHAT: something\nthat helps ${k + 1}.\nWHY: because`).join('\n\n'));
  }
  if (/Score every idea/.test(p)) {
    const lines = p.split('\n').filter(l => /^I\d+\. /.test(l));
    return console.log(lines.map(l => { const n = l.match(/^I(\d+)/)[1]; return `I${n}: ${/idea 2/.test(l) ? 9 : /idea 1/.test(l) ? 6 : 3} - ok`; }).join('\n'));
  }
  console.log('?');
});
