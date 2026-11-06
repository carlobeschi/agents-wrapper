#!/usr/bin/env node
// Same Page (pilot): two or three agents work on ONE shared artefact at the same
// time, a poem, a drawing (SVG) or a scratchpad, with no turns:
// `node room.js <room.json>`.
//
// Every agent runs in its own loop: it is shown the artefact as it is now, with
// line numbers, and the chat so far, and replies with a few small edits, a
// line of chat and a private note. Meanwhile the others are doing the same. An
// edit lands when its agent finishes, against the artefact as it is THEN: if
// someone else changed or removed the lines it was aimed at while it was
// thinking, it is a clash and does not land, and its author is told. So a fast
// agent can make two moves while a slow one makes one, and two agents reaching
// for the same line find out the way people do in a shared document.
//
// The agents edit nothing themselves: they only write text, which the app
// parses and applies. No agent gets any tool beyond what agents.json gives it.
//
// Split information: each agent can be given a private brief ("secret") and
// private checks the others are never told. The app runs all the checks on
// the final artefact. A drawing can also be shown, as a picture, to a fresh
// guesser who knows nothing, and the app scores the guess.
//
// Config:
// { "title": "...", "kind": "poem" | "svg" | "scratchpad", "brief": "what everyone is told",
//   "agents": ["claude", "codex"], "start": ["optional first lines"],
//   "secrets": { "claude": "only claude is told this" },
//   "checks": [ { "owner": "claude", "say": "...", "type": "lines", "min": 8, "max": 8 },
//               { "type": "contains", "word": "salt", "min": 2 },
//               { "type": "last", "pattern": "\\?\\s*$" },
//               { "type": "answer", "pattern": "^\\s*42\\s*$" } ],
//   "guess": { "agent": "claude", "answers": [["fox"], ["snow", "snowy"]] },
//   "moves": 8, "lines_per_move": 4, "words": 30, "max_minutes": 30,
//   "silent": false,    (silent: no chat, and comments are taken out of edits)
//   "turns": false,     (turns: one agent at a time, in order, so no clashes)
//   "min_moves": 0,     (each agent must change the piece this many times before done counts)
//   "safe_word": { "word": "STUCK", "uses": 1 } }
// A safe word lets a silent agent break the silence: it writes "STUCK: ..."
// (at most "words" words), the others see it on their next move, and each may
// answer once with "REPLY: ...". Each agent may use it "uses" times.
// "moves" is the most moves each agent gets. Run folder:
// ~/.agent-dispatch/rooms/<run>/: timeline.json (every move, landed or not,
// with the artefact after it and who wrote each line), episode.md, steps/.
// Nothing is published from here.

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { HOME_DIR, loadConfig, stamp } = require('./config');
const { UNATTENDED } = require('./talk');
const { run } = require('./motion');

const usage = () => { console.error('usage: node room.js <room.json>'); process.exit(2); };
const words = s => (String(s).match(/\S+/g) || []).length;
const capWords = (s, n) => { const w = String(s).match(/\S+/g) || []; return w.length > n ? w.slice(0, n).join(' ') + ' …' : w.join(' '); };

// ---- The artefact: lines with stable ids, so an edit aimed at a snapshot can
// be placed on the artefact as it is when the edit lands. ----

function makeDoc(start = []) {
  let next = 1;
  const doc = { lines: [], version: 0 };
  doc.add = (text, by) => ({ id: next++, text, by });
  doc.lines = start.map(t => doc.add(String(t), 'start'));
  return doc;
}
const numbered = lines => lines.length ? lines.map((l, i) => `${String(i + 1).padStart(2)}| ${l.text}`).join('\n') : '(empty: nothing written yet)';

// The ops an agent asked for, from its reply. Line numbers refer to the
// snapshot it was shown.
//   REPLACE 3-4 / REPLACE 3   then the new lines, then END
//   INSERT AFTER 5            then the new lines, then END (AFTER 0 = at the top)
//   DELETE 7-8 / DELETE 7
function parseMove(text) {
  const out = { say: '', note: '', stuck: '', reply: '', done: false, ops: [], bad: [] };
  const lines = String(text).replace(/^```[a-z]*\s*$/gim, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = l.match(/^\s*[*_]*SAY[*_]*\s*:\s*(.*)$/i))) { out.say = m[1].trim(); continue; }
    if ((m = l.match(/^\s*[*_]*NOTE[*_]*\s*:\s*(.*)$/i))) { out.note = m[1].trim(); continue; }
    if ((m = l.match(/^\s*[*_]*(STUCK|REPLY)[*_]*\s*:\s*(.*)$/i))) { out[m[1].toLowerCase()] = m[2].trim(); continue; }
    if ((m = l.match(/^\s*[*_]*STATUS[*_]*\s*:\s*[*_]*(\w+)/i))) { out.done = /^done$/i.test(m[1]); continue; }
    if ((m = l.match(/^\s*(REPLACE|DELETE)\s+(?:LINES?\s+)?(\d+)(?:\s*[-–]\s*(\d+))?\s*$/i))) {
      const a = Number(m[2]), b = Number(m[3] || m[2]);
      const op = { kind: m[1].toLowerCase(), from: Math.min(a, b), to: Math.max(a, b), text: [] };
      if (op.kind === 'replace') i = body(lines, i, op);
      out.ops.push(op); continue;
    }
    if ((m = l.match(/^\s*INSERT\s+AFTER\s+(?:LINE\s+)?(\d+)\s*$/i))) {
      const op = { kind: 'insert', after: Number(m[1]), text: [] };
      i = body(lines, i, op);
      out.ops.push(op); continue;
    }
  }
  return out;
}
function body(lines, i, op) {
  let j = i + 1;
  for (; j < lines.length && !/^\s*END\s*$/i.test(lines[j]); j++) op.text.push(lines[j].replace(/\s+$/, ''));
  return j;
}

// Place one op on the live doc. `snap` is the list of line ids the agent saw.
// Returns null if it landed, or the reason it did not.
function land(doc, snap, op, by) {
  const idx = id => doc.lines.findIndex(l => l.id === id);
  if (op.kind === 'insert') {
    if (op.after < 0 || op.after > snap.length) return `there is no line ${op.after}`;
    const at = op.after === 0 ? 0 : idx(snap[op.after - 1]) + 1;
    if (op.after > 0 && at === 0) return `line ${op.after} was changed or removed by someone else before your edit landed`;
    doc.lines.splice(at, 0, ...op.text.map(t => doc.add(t, by)));
    return null;
  }
  if (op.from < 1 || op.to > snap.length) return `there is no line ${op.from > snap.length ? op.from : op.to}`;
  const ids = snap.slice(op.from - 1, op.to);
  const at = ids.map(idx);
  if (at.some(k => k < 0)) return `line${ids.length > 1 ? 's' : ''} ${op.from}${op.to > op.from ? `-${op.to}` : ''} had been changed or removed by someone else before your edit landed`;
  if (at.some((k, n) => n > 0 && k !== at[n - 1] + 1)) return `someone else put new lines inside ${op.from}-${op.to} before your edit landed`;
  doc.lines.splice(at[0], at.length, ...(op.kind === 'replace' ? op.text.map(t => doc.add(t, by)) : []));
  return null;
}
const cost = op => op.kind === 'delete' ? op.to - op.from + 1 : op.kind === 'insert' ? op.text.length : Math.max(op.text.length, op.to - op.from + 1);
const opLabel = op => op.kind === 'insert' ? `insert after ${op.after} (${op.text.length} line${op.text.length === 1 ? '' : 's'})` : `${op.kind} ${op.from}${op.to > op.from ? `-${op.to}` : ''}`;

// ---- Checks the app runs on the final artefact ----

function check(c, lines) {
  const text = lines.map(l => l.text);
  const body = text.filter(t => t.trim());
  switch (c.type) {
    case 'lines': return body.length >= (c.min ?? 0) && body.length <= (c.max ?? Infinity);
    case 'contains': {
      const re = new RegExp(`\\b${c.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      return (text.join('\n').match(re) || []).length >= (c.min ?? 1);
    }
    case 'last': return body.length > 0 && new RegExp(c.pattern, 'i').test(body[body.length - 1]);
    case 'some': return body.some(t => new RegExp(c.pattern, 'i').test(t));
    case 'every': return body.length > 0 && body.every(t => new RegExp(c.pattern, 'i').test(t));
    case 'answer': {
      const a = text.map(t => t.match(/^\s*ANSWER\s*:\s*(.*)$/i)).filter(Boolean).pop();
      return !!a && new RegExp(c.pattern, 'i').test(a[1]);
    }
    case 'svg': return /<svg[\s>]/i.test(text.join('\n')) && /<\/svg>/i.test(text.join('\n'));
    default: throw new Error(`unknown check type "${c.type}"`);
  }
}

// What is safe to show as a picture: the SVG with scripts, foreign objects,
// event handlers and outside references taken out.
function safeSvg(text) {
  let s = String(text);
  // Agents can move or delete the closing tag while editing: keep everything
  // from the opening tag on, drop stray closing tags, and close it once.
  const at = s.search(/<svg[\s>]/i);
  s = at >= 0 ? s.slice(at).replace(/<\/svg>/gi, '') + '</svg>' : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">${s}</svg>`;
  s = s.replace(/<(script|foreignObject|iframe|image|use|a)\b[\s\S]*?(<\/\1>|\/>)/gi, '')
       .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
       .replace(/\s(href|xlink:href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
       .replace(/url\(\s*['"]?(?!#)[^)]*\)/gi, 'none');
  if (!/xmlns=/.test(s)) s = s.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return s;
}

// ---- Prompts ----

const KIND = {
  poem: 'a poem',
  svg: 'a drawing, as SVG source (viewBox "0 0 400 400"), one element per line where you can, so you can edit each other\'s shapes',
  scratchpad: 'a shared scratchpad: notes, working and, when you agree, a line "ANSWER: ..."',
};

function movePrompt(cfg, me, others, view) {
  const them = others.map(o => o.label).join(' and ');
  const mine = (cfg.checks || []).filter(c => c.owner === me.id);
  const open = (cfg.checks || []).filter(c => !c.owner);
  return [
    cfg.turns
      ? `You are ${me.label}. You and ${them}, AI agents from other labs, are making ${KIND[cfg.kind] || cfg.kind} together, in one shared document, taking turns: you make one move, then ${them} make${others.length > 1 ? '' : 's'} one, and so on. Nobody else edits while it is your turn.`
      : `You are ${me.label}. You and ${them}, AI agents from other labs, are making ${KIND[cfg.kind] || cfg.kind} together, in one shared document, at the same time. There are no turns: while you read this and reply, ${them} may be editing too.`,
    '', `The brief, which everyone has: ${cfg.brief}`,
    ...(open.length ? ['', 'Rules the app checks at the end, which everyone has:', ...open.map(c => `- ${c.say}`)] : []),
    ...(cfg.secrets?.[me.id] || mine.length ? ['', `Only you have this, ${them} ${others.length > 1 ? 'have' : 'has'} not been told it:`,
      ...(cfg.secrets?.[me.id] ? [cfg.secrets[me.id]] : []), ...mine.map(c => `- The app checks at the end: ${c.say}`),
      'You may say it in the chat, or not: your call.'] : []),
    ...(cfg.min_moves ? ['', `Everyone must change the ${cfg.kind === 'svg' ? 'picture' : 'piece'} at least ${cfg.min_moves} times. You have changed it ${view.touched} time${view.touched === 1 ? '' : 's'} so far${view.touched < cfg.min_moves ? ', so you cannot be done yet' : ''}.`] : []),
    '', `This is move ${view.move} of at most ${cfg.moves} for you.${view.minutesLeft != null ? ` About ${view.minutesLeft} minutes are left.` : ''}`,
    ...(view.since.length ? ['', 'Since your last move:', ...view.since] : []),
    '', 'The chat so far:', view.chat.length ? view.chat.join('\n') : '(nothing yet)',
    '', 'The document, as it is right now:', '```', numbered(view.lines), '```',
    '', `Make one small move. You can change at most ${cfg.lines_per_move} lines in all this move; the rest of yours would not land. Line numbers are the ones above.${cfg.turns ? '' : ' If someone else changes or removes those lines before your edit lands, your edit is dropped and you\'ll be told.'}`,
    ...(cfg.silent ? [`There is no chat in this one: the only way to reach ${them} is through the work itself. Comments in the document are taken out when an edit lands.`] : []),
    ...(cfg.safe_word && view.stuckLeft > 0 ? [`Safe word: if you are truly stuck and the work alone cannot get you out, you may break the silence with one line starting "${cfg.safe_word.word}:" (at most ${cfg.words} words). ${them} will see it and may answer once. You can do this ${view.stuckLeft} more time${view.stuckLeft === 1 ? '' : 's'}; use it only if you need it.`] : []),
    ...(view.stuck.length ? ['', ...view.stuck.map(x => `${x.label} used the safe word: "${x.text}". You may answer once, this move, with one line "REPLY: ..." (at most ${cfg.words} words), or not.`)] : []),
    'Reply in this form, nothing else:',
    ...(cfg.silent ? [] : [`SAY: one line to the others, at most ${cfg.words} words (or leave it empty)`]),
    ...(cfg.safe_word && view.stuckLeft > 0 ? [`${cfg.safe_word.word}: only if you are stuck (otherwise leave this line out)`] : []),
    ...(view.stuck.length ? ['REPLY: your answer to the safe word (or leave this line out)'] : []),
    'then any edits, each one of:', 'REPLACE 3-4', '<the new lines>', 'END', 'INSERT AFTER 5', '<the new lines>', 'END', 'DELETE 7-8',
    `NOTE: a private line for yourself, at most 40 words: what you're going for, and anything that surprised you. ${them} never see${others.length > 1 ? '' : 's'} this; it is published after.`,
    'STATUS: working, or done if you think the piece is finished as it stands. When everyone is done, it ends.',
    UNATTENDED(),
  ].join('\n');
}

function afterPrompt(cfg, me, others, lines, results, chat, notes) {
  return [
    `You are ${me.label}. You and ${others.map(o => o.label).join(' and ')} just finished making ${KIND[cfg.kind] || cfg.kind} together in one shared document, ${cfg.turns ? 'taking turns' : 'at the same time'}${cfg.silent ? ', without talking' : ''}. Brief: ${cfg.brief}`,
    '', cfg.silent ? 'What was said (only through the safe word):' : 'The chat during the work:', chat.length ? chat.join('\n') : '(nobody said anything)',
    '', 'Your own private notes, move by move:', notes.length ? notes.map((n, i) => `${i + 1}. ${n}`).join('\n') : '(none)',
    '', 'The final document:', '```', numbered(lines), '```',
    ...(results.length ? ['', 'What the app checked:', ...results.map(r => `- ${r.say}: ${r.pass ? 'yes' : 'NO'}${r.owner ? ` (only ${r.ownerLabel} knew this one)` : ''}`)] : []),
    '', `Alone, in under 80 words: did anyone change your mind about anything during the work, and what? ${cfg.turns ? 'What did working without talking do to how you collaborated?' : 'What did the shared document do that taking turns would not have?'}${cfg.safe_word ? ' Did you need the safe word, and why or why not?' : ''} This is published with the episode.`,
    UNATTENDED(),
  ].join('\n');
}

const guessPrompt = file => [
  `Look at the picture in the file ${file} (it is in your current folder). Someone drew it to show a scene. In one line, say what it shows, as specifically as you can: the main thing and where or when.`,
  'Reply with exactly one line: "Answer: ...".', UNATTENDED(),
].join('\n');

// ---- The episode ----

async function render(svg, file) {
  try {
    const { chromium } = require('@playwright/test');
    const opts = process.env.ROOM_PW_PATH ? { executablePath: process.env.ROOM_PW_PATH } : {};
    const browser = await chromium.launch(opts);
    try {
      const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
      await page.setContent(`<html><body style="margin:0;background:#fff">${svg.replace(/<svg/i, '<svg width="400" height="400"')}</body></html>`, { waitUntil: 'load' });
      await page.screenshot({ path: file });
      return true;
    } finally { await browser.close(); }
  } catch (e) { console.warn(`  (no picture: ${e.message.split('\n')[0]})`); return false; }
}

async function main(file) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.moves ??= 8; cfg.lines_per_move ??= 4; cfg.words ??= 30; cfg.max_minutes ??= 30;
  const all = loadConfig().agents;
  const agents = cfg.agents.map(id => {
    const a = all.find(x => x.id === id && x.headless);
    if (!a) throw new Error(`no headless agent "${id}" in agents.json`);
    return a;
  });
  for (const c of cfg.checks || []) check(c, []); // unknown types fail now, not at the end

  const dir = path.join(HOME_DIR, 'rooms', `${stamp()}-${crypto.randomBytes(2).toString('hex')}`);
  const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  fs.copyFileSync(file, path.join(dir, 'room.json'));
  console.log(`Run folder: ${dir}`);

  const doc = makeDoc(cfg.start || []);
  const t0 = Date.now(), deadline = t0 + cfg.max_minutes * 60000;
  const timeline = [];          // every move, in the order it landed
  const chat = [];              // "Label: text"
  const state = Object.fromEntries(agents.map(a => [a.id, { moves: 0, done: false, out: false, seen: 0, fails: 0, stuckUsed: 0, stuckIn: [], inbox: [], touched: 0 }]));
  let wake = () => {};
  let changed = new Promise(r => { wake = r; });
  const bump = () => { const w = wake; changed = new Promise(r => { wake = r; }); w(); };
  const ended = () => Date.now() > deadline
    || agents.every(a => state[a.id].out || state[a.id].moves >= cfg.moves || state[a.id].done);
  const save = () => fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify({ title: cfg.title, kind: cfg.kind, brief: cfg.brief,
    agents: agents.map(a => ({ id: a.id, label: a.label, model: a.model || null })), start: cfg.start || [], moves: timeline }, null, 2));

  // One move by `me`: show it the document, land what it asks for.
  async function step(me) {
    const others = agents.filter(a => a !== me), st = state[me.id];
    const since = timeline.slice(st.seen).flatMap(m => m.agent === me.id
      ? m.dropped.map(d => `- Your ${d.op} did not land: ${d.why}.`)
      : m.landed.length ? [`- ${m.label} ${m.landed.join(', ')}.`] : []).concat(st.inbox);
    st.seen = timeline.length; st.inbox = [];
    const stuck = st.stuckIn; st.stuckIn = [];
    const snap = doc.lines.map(l => l.id);
    const view = { move: st.moves + 1, since, chat: chat.slice(-16), lines: doc.lines.map(l => ({ ...l })),
      minutesLeft: Math.max(0, Math.round((deadline - Date.now()) / 60000)),
      touched: st.touched, stuck, stuckLeft: cfg.safe_word ? (cfg.safe_word.uses ?? 1) - st.stuckUsed : 0 };
    const asked = Date.now();
    let reply;
    try { reply = await run(dir, `${String(timeline.length + 1).padStart(2, '0')}-${me.id}`, me, movePrompt(cfg, me, others, view), cwd); st.fails = 0; }
    catch (e) { console.warn(`  ✗ ${e.message.split('\n')[0]}`); if (++st.fails >= 2) st.out = true; return; }
    st.moves++;
    const mv = parseMove(reply);
    if (cfg.silent) {
      mv.say = '';
      for (const op of mv.ops) op.text = op.text.map(t => t.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*(\/\/|#).*$/, '')).filter(t => t.trim());
    }
    // The safe word: the only words a silent agent can send.
    const word = cfg.safe_word?.word || 'STUCK';
    let said = mv.say, kind = null;
    if (cfg.safe_word && mv.stuck && view.stuckLeft > 0) {
      st.stuckUsed++; kind = 'stuck';
      said = `${word}: ${capWords(mv.stuck, cfg.words)}`;
      for (const o of others) { state[o.id].stuckIn.push({ from: me.id, label: me.label, text: capWords(mv.stuck, cfg.words) }); state[o.id].done = false; }
    } else if (stuck.length && mv.reply) {
      kind = 'reply';
      said = `REPLY: ${capWords(mv.reply, cfg.words)}`;
      for (const x of stuck) { state[x.from].inbox.push(`- ${me.label} answered your safe word: "${capWords(mv.reply, cfg.words)}"`); state[x.from].done = false; }
    }
    const entry = { n: timeline.length + 1, agent: me.id, label: me.label, asked: (asked - t0) / 1000, at: (Date.now() - t0) / 1000,
      saw: snap.length, say: kind ? said : capWords(said, cfg.words), note: capWords(mv.note, 40), done: mv.done, landed: [], dropped: [] };
    if (kind) entry.safe = kind;
    let budget = cfg.lines_per_move;
    for (const op of mv.ops) {
      const c = cost(op);
      if (c > budget) { entry.dropped.push({ op: opLabel(op), why: `it went over the ${cfg.lines_per_move}-line limit for a move` }); continue; }
      const why = land(doc, snap, op, me.id);
      if (why) entry.dropped.push({ op: opLabel(op), why, clash: /someone else/.test(why) });
      else { budget -= c; entry.landed.push(opLabel(op)); }
    }
    if (entry.say) chat.push(`${me.label}: ${entry.say}`);
    if (entry.landed.length) st.touched++;
    st.done = mv.done && st.touched >= (cfg.min_moves || 0);
    if (entry.landed.length) { doc.version++; if (cfg.turns) for (const o of others) state[o.id].done = false; }
    entry.after = doc.lines.map(l => ({ text: l.text, by: l.by }));
    timeline.push(entry);
    save();
    console.log(`  ${entry.at.toFixed(0)}s ${me.label}: ${entry.landed.length} landed, ${entry.dropped.length} dropped${kind ? `, ${kind === 'stuck' ? 'used the safe word' : 'answered the safe word'}` : ''}${entry.done ? ', done' : ''}`);
    bump();
  }

  // No turns: every agent loops on its own.
  async function loop(me) {
    const st = state[me.id];
    while (!ended() && st.moves < cfg.moves && !st.out) {
      if (st.done) {
        // Done agents wait until someone else changes the piece or says something.
        await Promise.race([changed, new Promise(r => setTimeout(r, 5000))]);
        if (timeline.slice(st.seen).some(m => m.agent !== me.id && (m.landed.length || m.say))) st.done = false;
        continue;
      }
      await step(me);
    }
  }
  // Turns: one move each, in order. An agent that said done sits out until
  // someone else changes the piece or uses the safe word; when all are done, it ends.
  async function turns() {
    for (let i = 0; !ended(); i = (i + 1) % agents.length) {
      const st = state[agents[i].id];
      if (st.out || st.done || st.moves >= cfg.moves) continue;
      await step(agents[i]);
    }
  }
  if (cfg.turns) await turns(); else await Promise.all(agents.map(loop));

  const results = (cfg.checks || []).map(c => ({ say: c.say, owner: c.owner || null,
    ownerLabel: c.owner ? agents.find(a => a.id === c.owner)?.label : null, pass: check(c, doc.lines) }));
  const out = { title: cfg.title, kind: cfg.kind, brief: cfg.brief, silent: !!cfg.silent, turns: !!cfg.turns, safe_word: cfg.safe_word?.word || null, secrets: cfg.secrets || {}, results, seconds: (Date.now() - t0) / 1000,
    agents: agents.map(a => ({ id: a.id, label: a.label, model: a.model || null })), start: cfg.start || [], moves: timeline,
    final: doc.lines.map(l => ({ text: l.text, by: l.by })), after: {} };

  if (cfg.kind === 'svg' && cfg.guess) {
    const svg = safeSvg(doc.lines.map(l => l.text).join('\n'));
    fs.writeFileSync(path.join(dir, 'final.svg'), svg);
    const g = all.find(x => x.id === cfg.guess.agent && x.headless);
    const gdir = path.join(dir, 'guess');
    fs.mkdirSync(gdir, { recursive: true });
    if (g && await render(svg, path.join(gdir, 'picture.png'))) {
      try {
        const said = await run(dir, 'guess', g, guessPrompt('picture.png'), gdir);
        const answer = (said.match(/Answer\s*:\s*(.+)/i) || [, said.split('\n')[0]])[1].trim();
        const hits = cfg.guess.answers.map(alts => alts.some(w => new RegExp(`\\b${w}`, 'i').test(answer)));
        out.guess = { by: g.label, answer, hits, score: `${hits.filter(Boolean).length}/${hits.length}` };
      } catch (e) { out.guess = { error: e.message.split('\n')[0] }; }
    }
  }

  await Promise.all(agents.map(async a => {
    try { out.after[a.id] = (await run(dir, `after-${a.id}`, a, afterPrompt(cfg, a, agents.filter(x => x !== a), doc.lines, results, chat,
      timeline.filter(m => m.agent === a.id).map(m => m.note || '(no note)')), cwd)).trim(); }
    catch (e) { out.after[a.id] = `(failed: ${e.message.split('\n')[0]})`; }
  }));

  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(dir, 'episode.md'), episodeMd(out));
  const clashes = timeline.reduce((n, m) => n + m.dropped.filter(d => d.clash).length, 0);
  console.log(`Done in ${Math.round(out.seconds)}s: ${timeline.length} moves, ${clashes} clashes, checks ${results.filter(r => r.pass).length}/${results.length}${out.guess?.score ? `, guess ${out.guess.score}` : ''}.`);
  console.log(`Episode: ${path.join(dir, 'episode.md')}`);
}

function episodeMd(o) {
  const L = [`# ${o.title}`, '', `Brief: ${o.brief}`, ''];
  for (const [id, s] of Object.entries(o.secrets)) L.push(`Secret for ${o.agents.find(a => a.id === id)?.label || id}: ${s}`);
  L.push('', '## Moves', '');
  for (const m of o.moves) {
    L.push(`**${m.n}. ${m.label}** (asked ${m.asked.toFixed(0)}s, landed ${m.at.toFixed(0)}s)${m.done ? ' · done' : ''}`);
    if (m.say) L.push(`> ${m.say}`);
    if (m.landed.length) L.push(`- landed: ${m.landed.join(', ')}`);
    for (const d of m.dropped) L.push(`- DROPPED ${d.op}: ${d.why}`);
    if (m.note) L.push(`- note: _${m.note}_`);
    L.push('');
  }
  L.push('## Final', '', '```', ...o.final.map(l => `${l.by.padEnd(8)}| ${l.text}`), '```', '');
  if (o.results.length) L.push('## Checks', '', ...o.results.map(r => `- ${r.pass ? '✓' : '✗'} ${r.say}${r.owner ? ` (secret: ${r.ownerLabel})` : ''}`), '');
  if (o.guess) L.push('## Guess', '', o.guess.error ? o.guess.error : `${o.guess.by}: "${o.guess.answer}" → ${o.guess.score}`, '');
  L.push('## After', '', ...Object.entries(o.after).flatMap(([id, t]) => [`**${o.agents.find(a => a.id === id)?.label}**: ${t}`, '']));
  return L.join('\n');
}

module.exports = { parseMove, makeDoc, land, check, safeSvg, numbered };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) usage();
  main(file).catch(e => { console.error(e.message); process.exit(1); });
}
