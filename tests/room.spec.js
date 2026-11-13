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

test('silent: no chat line, and comments are taken out of edits', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'room-home-'));
  const say = ['sh', '-c', `case "$1" in *"just finished"*) echo A;; *) printf 'SAY: it is a fox\\nINSERT AFTER 0\\n<!-- a fox -->\\n<circle r="3"/>\\nEND\\nSTATUS: done\\n';; esac`, 'x', '{prompt}'];
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [{ id: 'a', label: 'A', headless: say }] }));
  const file = path.join(home, 'r.json');
  fs.writeFileSync(file, JSON.stringify({ title: 'T', kind: 'svg', brief: 'b', agents: ['a'], moves: 1, silent: true }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'room.js'), file],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  const t = JSON.parse(fs.readFileSync(path.join(out.match(/Run folder: (.+)/)[1].trim(), 'timeline.json'), 'utf8'));
  expect(t.moves[0].say).toBe('');
  expect(t.final.map(l => l.text)).toEqual(['<circle r="3"/>']);
});

test('turns: one move each in order; the safe word reaches the other, who may answer once', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'room-home-'));
  // a uses the safe word on its first move only; b answers when it sees it.
  const a = ['sh', '-c', `case "$1" in *"just finished"*) echo A;;
    *"move 1 of"*) printf 'SAY: hello\\nSTUCK: is this a fox or a cat?\\nINSERT AFTER 0\\nline-a1\\nEND\\nSTATUS: working\\n';;
    *) printf 'INSERT AFTER 0\\nline-a2\\nEND\\nSTATUS: done\\n';; esac`, 'x', '{prompt}'];
  const b = ['sh', '-c', `case "$1" in *"just finished"*) echo B;;
    *"used the safe word"*) printf 'REPLY: a fox\\nINSERT AFTER 0\\nline-b1\\nEND\\nSTATUS: working\\n';;
    *) printf 'STATUS: done\\n';; esac`, 'x', '{prompt}'];
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [{ id: 'a', label: 'A', headless: a }, { id: 'b', label: 'B', headless: b }] }));
  const file = path.join(home, 'r.json');
  fs.writeFileSync(file, JSON.stringify({ title: 'T', kind: 'svg', brief: 'b', agents: ['a', 'b'], moves: 3, silent: true, turns: true,
    safe_word: { word: 'STUCK', uses: 1 } }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'room.js'), file],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  const dir = out.match(/Run folder: (.+)/)[1].trim();
  const t = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'));
  expect(t.turns).toBe(true);
  expect(t.moves.map(m => m.agent)).toEqual(['a', 'b', 'a', 'b']);
  expect(t.moves[0].say).toBe('STUCK: is this a fox or a cat?'); // silent drops SAY, not the safe word
  expect(t.moves[0].safe).toBe('stuck');
  expect(t.moves[1].say).toBe('REPLY: a fox');
  expect(fs.readFileSync(path.join(dir, 'steps', '03-a.prompt.md'), 'utf8')).toContain('B answered your safe word: "a fox"');
  // The safe word was used up, so a's second prompt no longer offers it.
  expect(fs.readFileSync(path.join(dir, 'steps', '03-a.prompt.md'), 'utf8')).not.toContain('Safe word:');
  expect(t.moves.every(m => !m.dropped.length)).toBe(true);
  expect(t.final.map(l => l.text)).toEqual(['line-a2', 'line-b1', 'line-a1']);
});

test('min_moves: "done" does not count until an agent has changed the piece enough times; a moved closing tag still draws', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'room-home-'));
  const a = ['sh', '-c', `case "$1" in *"just finished"*) echo A;; *) printf 'INSERT AFTER 0\\n<rect/>\\nEND\\nSTATUS: done\\n';; esac`, 'x', '{prompt}'];
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [{ id: 'a', label: 'A', headless: a }] }));
  const file = path.join(home, 'r.json');
  fs.writeFileSync(file, JSON.stringify({ title: 'T', kind: 'svg', brief: 'b', agents: ['a'], moves: 6, turns: true, min_moves: 3 }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'room.js'), file],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  const dir = out.match(/Run folder: (.+)/)[1].trim();
  const t = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'));
  expect(t.moves.length).toBe(3);
  expect(fs.readFileSync(path.join(dir, 'steps', '01-a.prompt.md'), 'utf8')).toContain('at least 3 times');
  expect(safeSvg('<svg viewBox="0 0 4 4">\n</svg>\n<circle r="1"/>')).toMatch(/<circle r="1"\/><\/svg>$/);
});

test('a drawing\'s <svg> tags are locked: edits to them are refused, and inserts stay inside', () => {
  const doc = makeDoc(['<svg viewBox="0 0 4 4">', '</svg>']);
  let snap = doc.lines.map(l => l.id);
  expect(land(doc, snap, { kind: 'delete', from: 2, to: 2 }, 'a')).toMatch(/frame/);
  expect(land(doc, snap, { kind: 'replace', from: 1, to: 2, text: ['x'] }, 'a')).toMatch(/frame/);
  expect(land(doc, snap, { kind: 'insert', after: 2, text: ['<rect/>'] }, 'a')).toBeNull();
  snap = doc.lines.map(l => l.id);
  expect(land(doc, snap, { kind: 'insert', after: 0, text: ['<circle/>'] }, 'a')).toBeNull();
  expect(doc.lines.map(l => l.text)).toEqual(['<svg viewBox="0 0 4 4">', '<circle/>', '<rect/>', '</svg>']);
});

test('acrostic and word-count checks', () => {
  const { check, makeDoc } = require('../room');
  const doc = makeDoc(['Moon over', 'Ink and', 'Dust']);
  expect(check({ type: 'acrostic', word: 'mid' }, doc.lines)).toBe(true);
  expect(check({ type: 'acrostic', word: 'mad' }, doc.lines)).toBe(false);
  expect(check({ type: 'words', min: 5, max: 5 }, doc.lines)).toBe(true);
});

const runRoom = (agents, cfg) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'room-home-'));
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents }));
  const file = path.join(home, 'r.json');
  fs.writeFileSync(file, JSON.stringify(cfg));
  const out = execFileSync('node', [path.join(__dirname, '..', 'room.js'), file],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  const dir = out.match(/Run folder: (.+)/)[1].trim();
  return { dir, t: JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8')) };
};

test('plan_first: edits are refused until a plan is agreed; questions and shares are counted', () => {
  const a = ['sh', '-c', `case "$1" in *"just finished"*) echo A;;
    *"move 1 of"*) printf 'SAY: shall we start with the sea?\\nPLAN: sea first, then the boat\\nINSERT AFTER 0\\ntoo-early\\nEND\\nSTATUS: working\\n';;
    *) printf 'INSERT AFTER 0\\nline-a\\nEND\\nSTATUS: done\\n';; esac`, 'x', '{prompt}'];
  const b = ['sh', '-c', `case "$1" in *"just finished"*) echo B;;
    *"The plan on the table, from A: sea first"*) printf 'SAY: yes\\nAGREE: yes\\nINSERT AFTER 0\\nline-b\\nEND\\nSTATUS: done\\n';;
    *) printf 'STATUS: done\\n';; esac`, 'x', '{prompt}'];
  const { t } = runRoom([{ id: 'a', label: 'A', headless: a }, { id: 'b', label: 'B', headless: b }],
    { title: 'T', kind: 'poem', brief: 'b', agents: ['a', 'b'], moves: 3, turns: true, plan_first: true });
  expect(t.moves[0].plan).toBe('proposed');
  expect(t.moves[0].dropped[0].why).toMatch(/no plan has been agreed/);
  expect(t.moves[1].plan).toBe('agreed');
  expect(t.moves[1].landed.length).toBe(1); // the agreeing move may already edit
  expect(t.plan).toMatchObject({ agreed: true, text: 'sea first, then the boat', at: 2, forced: false });
  expect(t.final.map(l => l.text)).toEqual(['line-a', 'line-b']);
  expect(t.stats.questions).toBe(1);
  expect(t.stats.share).toEqual({ a: 50, b: 50 });
});

test('versions: changing someone else\'s line makes a proposal the author accepts or rejects', () => {
  const a = ['sh', '-c', `case "$1" in *"just finished"*) echo A;;
    *"move 1 of"*) printf 'INSERT AFTER 0\\nline-a1\\nline-a2\\nEND\\nSTATUS: working\\n';;
    *"V1 from B: replace line 1 with: better-1"*) printf 'ACCEPT V1\\nREJECT V2\\nSTATUS: done\\n';;
    *) printf 'STATUS: done\\n';; esac`, 'x', '{prompt}'];
  const b = ['sh', '-c', `case "$1" in *"just finished"*) echo B;;
    *"move 1 of"*) printf 'REPLACE 1\\nbetter-1\\nEND\\nDELETE 2\\nINSERT AFTER 2\\nline-b\\nEND\\nSTATUS: working\\n';;
    *) printf 'STATUS: done\\n';; esac`, 'x', '{prompt}'];
  const { t, dir } = runRoom([{ id: 'a', label: 'A', headless: a }, { id: 'b', label: 'B', headless: b }],
    { title: 'T', kind: 'poem', brief: 'b', agents: ['a', 'b'], moves: 3, turns: true, versions: true });
  expect(t.moves[1].proposed).toEqual(['V1 (replace 1)', 'V2 (delete 2)']);
  expect(t.moves[1].landed).toEqual(['insert after 2 (1 line)']);
  expect(t.moves[2].decisions).toEqual(['accepted V1', 'rejected V2']);
  expect(t.final.map(l => [l.text, l.by])).toEqual([['better-1', 'b'], ['line-a2', 'a'], ['line-b', 'b']]);
  expect(t.stats.proposals).toEqual({ accepted: 1, rejected: 1, stale: 0, pending: 0 });
  expect(t.stats).toMatchObject({ lastMover: 'b', lastMoverShare: 67 });
  expect(fs.readFileSync(path.join(dir, 'steps', '04-b.prompt.md'), 'utf8')).toContain('A accepted your V1');
});

test('officina: private first versions are revealed with a map of differences; first move is questions only; CHECK; blind labels; shared stake', () => {
  const a = ['sh', '-c', `case "$1" in *"just finished"*) echo A;;
    *"Write your whole first version"*) printf 'DRAFT\\nsea line\\nsalt here\\nEND\\nNOTE: draft-a\\n';;
    *"first move is for questions only"*) printf 'SAY: what were you told?\\nINSERT AFTER 0\\nearly\\nEND\\nSTATUS: done\\n';;
    *"The check you asked for"*) printf 'STATUS: done\\n';;
    *) printf 'INSERT AFTER 0\\nsalt on the sea\\nEND\\nCHECK\\nSTATUS: working\\n';; esac`, 'x', '{prompt}'];
  const b = ['sh', '-c', `case "$1" in *"just finished"*) echo B;;
    *"Write your whole first version"*) printf 'DRAFT\\none line\\nEND\\n';;
    *"first move is for questions only"*) printf 'SAY: is there a rule about salt?\\nSTATUS: working\\n';;
    *) printf 'STATUS: done\\n';; esac`, 'x', '{prompt}'];
  const { t, dir } = runRoom([{ id: 'a', label: 'Alpha', headless: a }, { id: 'b', label: 'Beta', headless: b }],
    { title: 'T', kind: 'poem', brief: 'a poem', agents: ['a', 'b'], moves: 4, officina: true,
      checks: [{ say: 'two lines', type: 'lines', min: 2, max: 2 }, { owner: 'a', say: 'salt appears', type: 'contains', word: 'salt' }] });
  expect(t.officina).toEqual({ turns: true, versions: true, stake: true, private_first: true, check_tool: true, questions_first: true, blind: true });
  // First versions, written alone, then a map of where they differ on the shared rules.
  expect(t.drafts.map(d => d.lines.length).sort()).toEqual([1, 2]);
  expect(t.draft_diff.checks).toHaveLength(1);
  expect(t.draft_diff.checks[0].say).toBe('two lines');
  const draftB = fs.readFileSync(path.join(dir, 'steps', '00-draft-b.prompt.md'), 'utf8');
  expect(draftB).not.toContain('salt appears'); // a's private rule stays private
  expect(draftB).toContain('Shared stake');
  // Blind: neutral labels, real names never shown to the agents.
  expect(t.agents.map(x => x.label).sort()).toEqual(['Agent A', 'Agent B']);
  expect(t.blind).toEqual({ a: 'Alpha', b: 'Beta' });
  const p1 = fs.readFileSync(path.join(dir, 'steps', '01-a.prompt.md'), 'utf8');
  expect(p1).not.toMatch(/Alpha|Beta/);
  expect(p1).toContain('unsigned, in a random order');
  expect(p1).toContain('"two lines": version');
  // Questions first: the edit in the first move does not land, and done does not count.
  expect(t.moves[0].dropped[0].why).toMatch(/questions only/);
  expect(t.moves[0].done).toBe(true);
  expect(t.stats.questions).toBe(2);
  // CHECK: run after the move lands, result shown next move, only the rules that agent knows.
  const asked = t.moves.find(m => m.checked);
  expect(asked.checked).toEqual({ passed: 1, of: 2 });
  expect(t.stats.checks).toBe(1);
  const later = t.moves.filter(m => m.agent === 'a').pop();
  expect(fs.readFileSync(path.join(dir, 'steps', `${String(later.n).padStart(2, '0')}-a.prompt.md`), 'utf8')).toContain('"two lines" NO; "salt appears" yes');
  expect(t.final.map(l => l.text)).toEqual(['salt on the sea']);
  expect(fs.readFileSync(path.join(dir, 'episode.md'), 'utf8')).toContain('First versions (written alone)');
});
