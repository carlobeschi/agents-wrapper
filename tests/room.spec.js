// @ts-check
// Same Page (room.js): agents edit one shared document at the same time; an
// edit aimed at lines someone else changed first does not land; the app runs
// the checks, secret ones included. Fake agents answer from the prompt.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseMove, makeDoc, land, check, safeSvg } = require('../room');

const fake = name => ['sh', '-c', `case "$1" in
  *"just finished"*) echo "AFTER-${name}";;
  *) ${name === 'b' ? 'sleep 1; ' : ''}printf '${name === 'a'
    ? 'SAY: I take line one\\nREPLACE 1\\nsalt on the window\\nEND\\nNOTE: PRIVATE-a\\nSTATUS: done\\n'
    : 'SAY: me too\\nREPLACE 1\\nB was here\\nEND\\nINSERT AFTER 0\\nB on top\\nEND\\nNOTE: PRIVATE-b\\nSTATUS: done\\n'}';;
esac`, 'x', '{prompt}'];

test('two agents at once: first to land wins the line, the other is told, checks run', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'room-home-'));
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: ['a', 'b'].map(n => ({ id: n, label: `Agent ${n}`, headless: fake(n) })) }));
  const file = path.join(home, 'r.json');
  fs.writeFileSync(file, JSON.stringify({ title: 'T', kind: 'poem', brief: 'a poem about the sea', agents: ['a', 'b'], start: ['first line'],
    secrets: { a: 'SECRET-FOR-A' }, moves: 1,
    checks: [{ owner: 'a', say: 'salt appears', type: 'contains', word: 'salt' }, { say: 'two lines', type: 'lines', min: 2, max: 2 }] }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'room.js'), file],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  const dir = out.match(/Run folder: (.+)/)[1].trim();
  const t = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'));
  // Only a is told its secret.
  expect(fs.readFileSync(path.join(dir, 'steps', '01-a.prompt.md'), 'utf8')).toContain('SECRET-FOR-A');
  expect(fs.readFileSync(path.join(dir, 'steps', '01-b.prompt.md'), 'utf8')).not.toContain('SECRET-FOR-A');
  const [first, second] = t.moves;
  expect(first.agent).toBe('a');
  expect(second.landed).toEqual(['insert after 0 (1 line)']);
  expect(second.dropped[0].clash).toBe(true);
  expect(t.final.map(l => l.text)).toEqual(['B on top', 'salt on the window']);
  expect(t.final.map(l => l.by)).toEqual(['b', 'a']);
  expect(t.results.map(r => r.pass)).toEqual([true, true]);
  expect(t.after.a).toBe('AFTER-a');
  expect(fs.readFileSync(path.join(dir, 'episode.md'), 'utf8')).toContain('DROPPED replace 1');
});

test('parsing and placing moves', () => {
  const m = parseMove('SAY: hi there\n```\nREPLACE 2-3\nx\ny\nEND\nDELETE 5\nINSERT AFTER 1\nz\nEND\n```\nNOTE: n\nSTATUS: working');
  expect(m.say).toBe('hi there');
  expect(m.ops.map(o => o.kind)).toEqual(['replace', 'delete', 'insert']);
  expect(m.done).toBe(false);
  const doc = makeDoc(['1', '2', '3', '4', '5']);
  const snap = doc.lines.map(l => l.id);
  expect(land(doc, snap, { kind: 'delete', from: 5, to: 5 }, 'a')).toBeNull();
  expect(land(doc, snap, { kind: 'insert', after: 2, text: ['new'] }, 'b')).toBeNull();
  // 2-3 now has a line inside it that the agent never saw.
  expect(land(doc, snap, { kind: 'replace', from: 2, to: 3, text: ['x'] }, 'c')).toMatch(/inside/);
  expect(land(doc, snap, { kind: 'delete', from: 5, to: 5 }, 'c')).toMatch(/someone else/);
  expect(land(doc, snap, { kind: 'replace', from: 9, to: 9, text: [] }, 'c')).toMatch(/no line/);
  expect(check({ type: 'answer', pattern: '^blue$' }, [{ text: 'ANSWER: blue' }])).toBe(true);
  expect(check({ type: 'last', pattern: '\\?$' }, [{ text: 'a' }, { text: 'why?' }, { text: '' }])).toBe(true);
});

test('a drawing is cleaned before it is shown as a picture', () => {
  const s = safeSvg('<svg viewBox="0 0 4 4"><script>x()</script><circle onload="x()" r="1" fill="url(http://e.com/a)"/><image href="http://e.com"/></svg>');
  expect(s).not.toMatch(/script|onload|e\.com|image/);
  expect(s).toContain('xmlns=');
});
