#!/usr/bin/env node
// Stands in for `codex exec --json`: reads the prompt on stdin, prints JSONL
// events, and acts on what the prompt says. See tests/pair.spec.js.
const fs = require('fs');
const resume = process.argv.includes('resume');
const out = ev => process.stdout.write(JSON.stringify(ev) + '\n');
const say = text => out({ type: 'item.completed', item: { type: 'agent_message', text } });
const write = n => { fs.writeFileSync('answer.txt', String(n)); out({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'answer.txt', kind: 'add' }] } }); };
const wait = ms => new Promise(r => setTimeout(r, ms));
let prompt = '';
process.stdin.on('data', d => prompt += d);
process.stdin.on('end', async () => {
  fs.appendFileSync('../driver-prompts.txt', `--- ${resume ? 'resume ' + process.argv[process.argv.indexOf('resume') + 1] : 'start'}\n${prompt}\n`);
  if (!resume) out({ type: 'thread.started', thread_id: 'th-123' });
  out({ type: 'turn.started' });
  if (!resume) { say('Reading the task.\nHELP: which number should it be?'); await wait(5000); say('never seen'); return; }
  if (prompt.includes('answers your question')) { write(41); await wait(4000); say('Done, never reached'); return; }
  if (prompt.includes('cuts in')) { write(42); say('Fixed. Done.'); out({ type: 'turn.completed' }); return; }
  say('Nothing to do.');
});
