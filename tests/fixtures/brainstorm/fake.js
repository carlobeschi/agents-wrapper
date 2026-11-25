// A fake agent for the brainstorm app: reads the prompt on stdin and answers
// by its shape. argv: <read|build> <name>. No model is called.
const fs = require('fs');
const [mode, name] = process.argv.slice(2);
let p = '';
process.stdin.on('data', c => { p += c; });
process.stdin.on('end', () => {
  if (mode === 'build') {
    if (/hello\.txt/.test(p)) { fs.writeFileSync('hello.txt', 'hi'); return console.log('done'); }
    // Agent b fails once, before touching anything, as a provider error would.
    const mark = require('path').join(require('os').tmpdir(), `bs-fake-${require('crypto').createHash('md5').update(process.cwd()).digest('hex')}`);
    if (name === 'b' && !fs.existsSync(mark)) { fs.writeFileSync(mark, 'x'); console.error('provider error'); process.exit(2); }
    fs.writeFileSync(`plan-${name}.md`, `# ${name}\n`);
    fs.writeFileSync('BRAINSTORM.md', `built by ${name} home ${require('path').basename(process.env.HOME || '')}\n`);
    return console.log(`WHAT I BUILT: a plan, by ${name} (Claude).\nHOW TO SEE IT: open plan-${name}.md\nNOT DONE: nothing`);
  }
  if (mode === 'research') {
    if (/Open the web page/.test(p)) return console.log('Example Domain');
    return console.log(`FINDING: ${name} fact one\nSOURCE: own knowledge\nFINDING: ${name} fact two\nSOURCE: notes.md\nSURPRISE: ${name} surprise\nSOURCE: own knowledge`);
  }
  if (/writing the instructions/.test(p)) {
    if (name === 'bad') return console.log('I would rather not.');
    return console.log('```json\n' + JSON.stringify({
      research: 'CUSTOM research by the writer. Problem: {problem}. Web: {web}. Readers: {sharing}.',
      ideas: 'CUSTOM ideas by the writer. Problem: {problem}. Notes: {notes}. Propose exactly {ideas_per_agent} ideas; {top} go forward.',
      vote: 'CUSTOM vote by the writer. Problem: {problem}. Score every idea below.\n{ideas}\nCriteria: {criteria}',
      build: 'CUSTOM build by the writer. Problem: {problem}. Notes: {notes}. Develop:\n{winners}\nCommands: {can_run}.',
    }) + '\n```');
  }
  if (/word\.txt/.test(p)) return console.log(fs.readFileSync('word.txt', 'utf8'));
  if (/Propose exactly (\d+)/.test(p)) {
    const n = Number(/Propose exactly (\d+)/.exec(p)[1]);
    const seen = fs.existsSync('notes.md') ? ' (read notes.md)' : '';
    return console.log(Array.from({ length: n }, (_, k) => `IDEA: ${name} idea ${k + 1}${seen}\nWHAT: something\nthat helps ${k + 1}.\nWHY: because`).join('\n\n'));
  }
  if (/Score every idea/.test(p)) {
    const lines = p.split('\n').filter(l => /^I\d+\. /.test(l));
    const crit = p.split('\n').filter(l => /^C\d+\. /.test(l)).length;
    // With criteria: a block per idea; the first criterion carries the preference, the others get 5.
    if (crit) return console.log(lines.map(l => { const n = l.match(/^I(\d+)/)[1]; const s = /idea 2/.test(l) ? 9 : /idea 1/.test(l) ? 6 : 3; return [`**I${n}**`, ...Array.from({ length: crit }, (_, k) => `- C${k + 1}: ${k ? 5 : s} - because ${k + 1}`)].join('\n'); }).join('\n\n'));
    return console.log(lines.map(l => { const n = l.match(/^I(\d+)/)[1]; return `I${n}: ${/idea 2/.test(l) ? 9 : /idea 1/.test(l) ? 6 : 3} - ok`; }).join('\n'));
  }
  console.log('?');
});
