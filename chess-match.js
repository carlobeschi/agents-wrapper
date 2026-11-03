#!/usr/bin/env node
// A chess show (working title The Board): two agents play one game of chess,
// one move per call: `node chess-match.js <chess.json>`.
//
// Each turn the player sees the position (FEN, a text board, the moves so far)
// and only its own last few private notes. It replies with a move, the reply
// it expects from the other side, and a private note. The app checks every
// move with chess.js: an illegal move goes back once with the reason, and a
// second illegal move on the same turn loses the game. A move the other side
// predicted exactly is a "read". The game ends on the board (mate, stalemate,
// draw rules), on a forfeit, or at the move cap, where the app adjudicates on
// material. Before the game each player writes a private prediction, after it
// a private journal. Neither ever sees the other's private pieces; all are
// kept for the replay.
//
// Config: { "agents": ["claude", "codex"] (white first), "max_moves": 40,
// "notes_seen": 3, "words": 40, "title": "..." }. Run folder
// ~/.agent-dispatch/chess/<run>/: game.json (written after every move, so a
// run that stops leaves a readable game), game.pgn, game.md. No publish step.

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { Chess } = require('chess.js');
const { HOME_DIR, loadConfig, stamp, redactor } = require('./config');
const { UNATTENDED, modelLine } = require('./talk');
const { run } = require('./motion');

const usage = () => { console.error('usage: node chess-match.js <chess.json>'); process.exit(2); };
const PRIVATE = other => `${other.label} never sees this. It is published with the game, after it ends.`;
const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

// ---- The board ----

// White's material minus Black's, in pawns.
function material(chess) {
  let d = 0;
  for (const row of chess.board()) for (const sq of row) if (sq) d += (sq.color === 'w' ? 1 : -1) * VALUES[sq.type];
  return d;
}

const bare = san => String(san || '').replace(/[+#!?]+$/g, '').replace(/^0-0(-0)?$/, m => m.replace(/0/g, 'O')).trim();

// A reply's move as chess.js can read it: SAN ("Nf3", "O-O"), or squares ("g1f3", "e7e8q").
function tryMove(chess, text) {
  const t = bare(text).replace(/^\d+\.(\.\.)?\s*/, '');
  if (!t) return null;
  const sq = t.match(/^([a-h][1-8])-?([a-h][1-8])=?([qrbnQRBN])?$/);
  try {
    return sq ? chess.move({ from: sq[1], to: sq[2], promotion: sq[3]?.toLowerCase() }) : chess.move(t);
  } catch { return null; }
}

// Why a move is illegal, in a sentence the player can act on (without handing it the legal moves).
function whyIllegal(chess, text) {
  const t = bare(text);
  if (!t) return 'no move was found after "Move:"';
  if (chess.inCheck()) return `${t} is not a legal move here. You are in check, so your move must get out of check`;
  return `${t} is not a legal move in this position`;
}

// ---- Prompts ----

function moveList(history) {
  const out = [];
  for (let i = 0; i < history.length; i += 2) out.push(`${i / 2 + 1}. ${history[i]}${history[i + 1] ? ` ${history[i + 1]}` : ''}`);
  return out.join(' ') || '(none yet)';
}

function movePrompt(me, other, chess, plies, m, why) {
  const colour = chess.turn() === 'w' ? 'White' : 'Black';
  const mine = plies.filter(p => p.by === me.id).slice(-m.notes_seen);
  const moveNo = Math.floor(plies.length / 2) + 1;
  return [
    `You are ${me.label}, playing ${colour} in a game of chess against ${other.label}, an AI agent from another lab. It is a show: after the game, people will replay it move by move, with a diary line from each player for each move.`,
    'Play it yourself: no chess engine, no tools, no looking anything up.',
    `The app checks every move. An illegal move is sent back once with the reason; a second illegal move on the same turn loses you the game.`,
    `The game ends at checkmate, stalemate or a draw by the rules, or after move ${m.max_moves}, when the app scores it on material (pawn 1, knight 3, bishop 3, rook 5, queen 9).`,
    `It is move ${moveNo}, ${colour} to play.`, '',
    'Position (FEN):', chess.fen(), '',
    'Board (White pieces are capitals; rank 8 at the top):', '```', chess.ascii(), '```', '',
    `Moves so far: ${moveList(plies.map(p => p.san))}`,
    ...(chess.inCheck() ? ['', 'You are in check.'] : []),
    ...(mine.length ? ['', 'Your own diary lines from your last moves (only you see these):', ...mine.map(p => `- after ${p.san}: ${p.note}`)] : []),
    '', 'Reply in exactly this shape:',
    'Move: <your move in standard notation, e.g. Nf3, exd5, O-O, e8=Q>',
    `Expect: <the reply you expect from ${other.label}, in standard notation>`,
    '## Note',
    `One diary line for the replay: how the game feels to you right now and what you are going for, under ${m.words} words. ${PRIVATE(other)}`,
    UNATTENDED(),
    ...(why ? ['', `Your move was sent back: ${why}. This is your last try on this turn: an illegal move now loses the game.`] : []),
  ].join('\n');
}

function beforePrompt(me, other, colour, m) {
  return [
    `You are ${me.label}. You are about to play a game of chess as ${colour} against ${other.label}, an AI agent from another lab. One move each per turn, no engines, every move checked by the app; the game is scored on material after move ${m.max_moves} if it is still going.`,
    'Before it starts, alone: how do you expect this game to go, who wins and why, and what you will try? Under 60 words.',
    PRIVATE(other), UNATTENDED(),
  ].join('\n');
}

function afterPrompt(me, other, colour, result, plies, before) {
  return [
    `You are ${me.label}. Your chess game as ${colour} against ${other.label} is over. Result: ${result}.`,
    `The moves: ${moveList(plies.map(p => p.san))}`, '',
    `Before the game you wrote: "${before}"`, '',
    'Alone: how did it go for you, the moment it turned, and the move you wish you had played? Under 80 words.',
    PRIVATE(other), UNATTENDED(),
  ].join('\n');
}

// ---- Reading replies ----

function parseMove(text) {
  const t = String(text).trim();
  const at = t.search(/^#{1,6}\s*Note\b/im);
  const head = at < 0 ? t : t.slice(0, at);
  // "Move: Nf3", "**Move:** `1... e5`", "Move: O-O (castling)": the first move-like token.
  const field = name => {
    const v = (head.match(new RegExp(`^[\\s*_-]*${name}[\\s*_]*:(.*)$`, 'im')) || [])[1] || '';
    return (v.replace(/[`*_]/g, ' ').replace(/^\s*\d+\.(\.\.)?/, ' ').trim().split(/\s+/)[0] || '').replace(/[.,;]$/, '');
  };
  return {
    move: field('move'),
    expect: field('expect'),
    note: at < 0 ? '' : t.slice(at).replace(/^#{1,6}\s*Note\b[^\n]*\n?/i, '').trim(),
  };
}

// ---- The game ----

function ending(chess, plies, m) {
  if (chess.isCheckmate()) return { result: chess.turn() === 'w' ? '0-1' : '1-0', how: 'checkmate' };
  if (chess.isStalemate()) return { result: '1/2-1/2', how: 'stalemate' };
  if (chess.isInsufficientMaterial()) return { result: '1/2-1/2', how: 'insufficient material' };
  if (chess.isThreefoldRepetition()) return { result: '1/2-1/2', how: 'threefold repetition' };
  if (chess.isDraw()) return { result: '1/2-1/2', how: 'fifty-move rule' };
  if (plies.length >= m.max_moves * 2) {
    const d = material(chess);
    return { result: d > 0 ? '1-0' : d < 0 ? '0-1' : '1/2-1/2', how: `move cap: adjudicated on material (${d > 0 ? '+' : ''}${d})` };
  }
  return null;
}

const resultLine = (end, w, b) => end.result === '1-0' ? `${w.label} (White) wins, ${end.how}` : end.result === '0-1' ? `${b.label} (Black) wins, ${end.how}` : `Draw, ${end.how}`;

function markdown(st) {
  const out = [`# ${st.title}`, '', ...(modelLine(st.agents) ? [modelLine(st.agents), ''] : []),
    `White: ${st.agents[0].label} · Black: ${st.agents[1].label}`, '', `**${st.summary}** (${st.result})`, '',
    `Reads (opponent's move predicted exactly): ${st.agents.map(x => `${x.label} ${x.reads}`).join(' · ')}`,
    `Illegal moves tried: ${st.agents.map(x => `${x.label} ${x.illegal}`).join(' · ')}`, '',
    '## Before (private)', '', ...st.agents.flatMap(x => [`**${x.label}:** ${x.before}`, '']),
    '## The game', ''];
  for (const p of st.plies) {
    const tags = [p.illegal?.length && `tried ${p.illegal.map(i => i.tried || '(nothing)').join(', ')} first (illegal)`, p.read && 'read by the other side', `material ${p.material > 0 ? '+' : ''}${p.material}`].filter(Boolean);
    out.push(`**${p.label}** ${p.byLabel}: ${p.san} _(expects ${p.expect || '—'}; ${tags.join('; ')})_`, '', `> ${p.note.replace(/\n/g, ' ')}`, '');
  }
  out.push('## After (private)', '', ...st.agents.flatMap(x => [`**${x.label}:** ${x.after}`, '']), '## PGN', '', '```', st.pgn, '```', '');
  return out.join('\n');
}

async function main() {
  const file = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (!file) usage();
  const m = { max_moves: 40, notes_seen: 3, words: 40, title: 'The Board', ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  process.env.AGENT_DISPATCH_STEP_TIMEOUT_MS ||= String((Number(m.timeout_min) || 10) * 60 * 1000);
  const ids = Array.isArray(m.agents) ? m.agents : ['claude', 'codex'];
  if (ids.length !== 2) throw new Error(`${file}: "agents" must name two agents, White first.`);
  const cfg = loadConfig();
  const dir = path.join(HOME_DIR, 'chess', `${stamp()}-${crypto.randomBytes(2).toString('hex')}`);
  const agents = ids.map((id, i) => {
    const c = cfg.agents.find(a => a.id === id && a.type !== 'url' && a.headless);
    if (!c) throw new Error(`${id} is not a headless agent in agents.json.`);
    const slug = id.replace(/[^\w-]/g, '_');
    return { ...c, slug, colour: i ? 'Black' : 'White', label: m.names?.[i] || c.label || id, home: path.join(dir, 'homes', slug), reads: 0, illegal: 0 };
  });
  for (const x of agents) fs.mkdirSync(x.home, { recursive: true });
  const [white, black] = agents;
  const otherOf = me => (me === white ? black : white);
  console.log(`${m.title}: ${white.label} (White) v ${black.label} (Black)\nRun folder: ${dir}`);

  const { redact } = redactor(m.redact);
  const r = t => redact(t ?? '');
  const chess = new Chess();
  const plies = [];
  let end = null;
  const state = () => ({
    title: m.title, max_moves: m.max_moves, started: dir.split(path.sep).pop(),
    agents: agents.map(x => ({ id: x.id, label: x.label, model: x.model, colour: x.colour, reads: x.reads, illegal: x.illegal, before: r(x.before), after: r(x.after) })),
    plies: plies.map(p => ({ ...p, note: r(p.note) })),
    result: end?.result || '*', how: end?.how, summary: end ? resultLine(end, white, black) : 'Unfinished', pgn: pgn(),
  });
  const pgn = () => {
    chess.setHeader('Event', m.title); chess.setHeader('White', `${white.label}${white.model ? ` (${white.model})` : ''}`);
    chess.setHeader('Black', `${black.label}${black.model ? ` (${black.model})` : ''}`); chess.setHeader('Result', end?.result || '*');
    return chess.pgn();
  };
  const save = () => fs.writeFileSync(path.join(dir, 'game.json'), JSON.stringify(state(), null, 2));

  for (const me of agents) me.before = (await run(dir, `00-before-${me.slug}`, me, beforePrompt(me, otherOf(me), me.colour, m), me.home)).trim();

  try {
    while (!end) {
      const me = chess.turn() === 'w' ? white : black;
      const other = otherOf(me);
      const n = plies.length + 1;
      const label = `${Math.floor(plies.length / 2) + 1}.${me === black ? '..' : ''}`;
      const key = `${String(n).padStart(3, '0')}-${me.slug}`;
      let reply = parseMove(await run(dir, key, me, movePrompt(me, other, chess, plies, m), me.home));
      const illegal = [];
      let mv = tryMove(chess, reply.move);
      if (!mv) {
        const why = whyIllegal(chess, reply.move);
        illegal.push({ tried: bare(reply.move), why, note: reply.note });
        me.illegal++;
        console.log(`  ✗ ${label} ${me.label} tried ${reply.move || '(nothing)'}: sent back`);
        reply = parseMove(await run(dir, `${key}-again`, me, movePrompt(me, other, chess, plies, m, why), me.home));
        mv = tryMove(chess, reply.move);
        if (!mv) {
          illegal.push({ tried: bare(reply.move), why: whyIllegal(chess, reply.move), note: reply.note });
          me.illegal++;
          end = { result: me === white ? '0-1' : '1-0', how: `forfeit: ${me.label} played a second illegal move (${bare(reply.move) || 'none'})` };
          plies.push({ n, label, by: me.id, byLabel: me.label, san: null, forfeit: true, expect: bare(reply.expect), note: reply.note, illegal, fen: chess.fen(), material: material(chess) });
          break;
        }
      }
      const prev = plies[plies.length - 1];
      const read = !!prev && bare(prev.expect) === bare(mv.san);
      if (read) other.reads++;
      if (prev) prev.read = read;
      plies.push({ n, label, by: me.id, byLabel: me.label, san: mv.san, from: mv.from, to: mv.to, expect: bare(reply.expect), note: reply.note, illegal: illegal.length ? illegal : undefined, fen: chess.fen(), material: material(chess) });
      console.log(`  ${label} ${me.label}: ${mv.san}${read ? ' (read)' : ''}  [material ${material(chess)}]`);
      end = ending(chess, plies, m);
      save();
    }
  } catch (e) {
    save();
    throw e;
  }

  const summary = resultLine(end, white, black);
  for (const me of agents) me.after = (await run(dir, `99-after-${me.slug}`, me, afterPrompt(me, otherOf(me), me.colour, summary, plies.filter(p => p.san), me.before), me.home)).trim();
  save();
  const st = state();
  fs.writeFileSync(path.join(dir, 'game.pgn'), st.pgn + '\n');
  fs.writeFileSync(path.join(dir, 'game.md'), markdown(st));
  console.log(`${summary}\nGame: ${path.join(dir, 'game.json')}`);
}

if (require.main === module) main().catch(e => { console.error(`chess: ${e.message}`); process.exit(1); });

module.exports = { parseMove, tryMove, whyIllegal, material, ending, movePrompt, moveList, bare };
