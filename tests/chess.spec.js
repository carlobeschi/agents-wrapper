// @ts-check
// The chess show (chess-match.js): two agents play one game, a move per call.
// chess.js checks every move; an illegal move goes back once, a second one
// loses; a move the other side predicted is a read. Fake agents play the
// shortest mate there is (1. f3 e5 2. g4 Qh4#), Black trying Ke7 first.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Chess } = require('chess.js');
const { parseMove, tryMove, material, ending } = require('../chess-match');

const fake = name => ['sh', '-c', `case "$1" in
  *"about to play"*) printf 'BEFORE-${name}\\n';;
  *"is over. Result"*) printf 'AFTER-${name}\\n';;
  *"Moves so far: (none yet)"*) printf 'Move: f3\\nExpect: e5\\n## Note\\nPRIVATE-a1\\n';;
  *"Your move was sent back"*) printf 'Move: e5\\nExpect: g4\\n## Note\\nPRIVATE-b1\\n';;
  *"Moves so far: 1. f3 e5 2. g4"*) printf '**Move:** Qh4#\\nExpect: none\\n## Note\\nPRIVATE-b2\\n';;
  *"Moves so far: 1. f3 e5"*) printf 'Move: g4\\nExpect: Qh4\\n## Note\\nPRIVATE-a2\\n';;
  *"Moves so far: 1. f3"*) printf 'Move: Ke7\\nExpect: g4\\n## Note\\nPRIVATE-b0\\n';;
esac`, 'x', '{prompt}'];

test('agents play a game; the app checks moves, illegal ones go back, reads are counted', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-home-'));
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: ['a', 'b'].map(n => ({ id: n, label: `Agent ${n}`, headless: fake(n) })) }));
  const file = path.join(home, 'c.json');
  fs.writeFileSync(file, JSON.stringify({ agents: ['a', 'b'], max_moves: 10 }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'chess-match.js'), file],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  const dir = out.match(/Run folder: (.+)/)[1].trim();
  const read = f => fs.readFileSync(path.join(dir, 'steps', f), 'utf8');
  // Each player sees only its own notes.
  expect(read('003-a.prompt.md')).toContain('PRIVATE-a1');
  expect(read('003-a.prompt.md')).not.toContain('PRIVATE-b');
  expect(read('002-b-again.prompt.md')).toContain('Ke7 is not a legal move');

  const g = JSON.parse(fs.readFileSync(path.join(dir, 'game.json'), 'utf8'));
  expect(g.plies.map(p => p.san)).toEqual(['f3', 'e5', 'g4', 'Qh4#']);
  expect(g.plies[1].illegal[0]).toMatchObject({ tried: 'Ke7' });
  expect(g).toMatchObject({ result: '0-1', how: 'checkmate', summary: 'Agent b (Black) wins, checkmate' });
  // a predicted e5 and Qh4 (two reads); b predicted g4 (one read).
  expect(g.agents.map(x => [x.reads, x.illegal])).toEqual([[2, 0], [1, 1]]);
  expect(g.agents[0]).toMatchObject({ before: 'BEFORE-a', after: 'AFTER-a' });
  expect(fs.readFileSync(path.join(dir, 'game.pgn'), 'utf8')).toContain('2. g4 Qh4# 0-1');
  expect(fs.readFileSync(path.join(dir, 'game.md'), 'utf8')).toContain('tried Ke7 first (illegal)');
});

test('a second illegal move on the same turn loses', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-home-'));
  const bad = ['sh', '-c', `case "$1" in *"about to play"*|*"is over"*) echo ok;; *) printf 'Move: Ke2\\nExpect: e4\\n## Note\\nx\\n';; esac`, 'x', '{prompt}'];
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: ['a', 'b'].map(n => ({ id: n, label: `Agent ${n}`, headless: bad })) }));
  const file = path.join(home, 'c.json');
  fs.writeFileSync(file, JSON.stringify({ agents: ['a', 'b'] }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'chess-match.js'), file],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  const g = JSON.parse(fs.readFileSync(path.join(out.match(/Run folder: (.+)/)[1].trim(), 'game.json'), 'utf8'));
  expect(g.result).toBe('0-1');
  expect(g.how).toContain('forfeit');
  expect(g.plies[0]).toMatchObject({ forfeit: true, san: null });
});

test('moves are read forgivingly; material and the move cap', () => {
  expect(parseMove('Move: `Nf3`\nExpect: d5\n## Note\nhi')).toEqual({ move: 'Nf3', expect: 'd5', note: 'hi' });
  expect(parseMove('**Move:** `1. e4` (centre)\nExpect: 1... e5\n')).toMatchObject({ move: 'e4', expect: 'e5' });
  expect(parseMove('Move: O-O.\n').move).toBe('O-O');
  const c = new Chess();
  expect(tryMove(c, 'e2e4').san).toBe('e4');
  expect(tryMove(c, '1...e5').san).toBe('e5');
  expect(tryMove(c, 'Qxf7')).toBe(null);
  expect(tryMove(c, '0-0')).toBe(null);
  expect(material(new Chess('4k3/8/8/8/8/8/8/R3K3 w - - 0 1'))).toBe(5);
  const capped = new Chess('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
  expect(ending(capped, new Array(2), { max_moves: 1 })).toMatchObject({ result: '1-0' });
});

test('a series swaps colours, and each player remembers only its own past games', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-home-'));
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: ['a', 'b'].map(n => ({ id: n, label: `Agent ${n}`, headless: fake(n) })) }));
  const file = path.join(home, 'c.json');
  fs.writeFileSync(file, JSON.stringify({ agents: ['a', 'b'], games: 2 }));
  const out = execFileSync('node', [path.join(__dirname, '..', 'chess-match.js'), file],
    { env: { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_RETRY_MS: '0' }, encoding: 'utf8' });
  const dir = out.match(/Run folder: (.+)/)[1].trim();
  const read = f => fs.readFileSync(path.join(dir, f), 'utf8');
  // Game 2: b is White, a is Black, and each sees only its own after-note.
  const before = read('game-02/steps/00-before-a.prompt.md');
  expect(before).toContain('as Black');
  expect(before).toContain('Game 1, you were White: Agent b (Black) wins, checkmate');
  expect(before).toContain('AFTER-a');
  expect(before).not.toContain('AFTER-b');
  expect(read('game-02/steps/002-a.prompt.md')).toContain('- Game 1: AFTER-a');
  const s = JSON.parse(read('series.json'));
  expect(s.games.map(g => g.result)).toEqual(['0-1', '0-1']);
  expect(s.agents.map(a => [a.wins, a.illegal])).toEqual([[1, 1], [1, 1]]);
  expect(s.draws).toBe(0);
});

test('the diary check flags a line that sounds fine while clearly down', () => {
  const { diaryCheck } = require('../chess-match');
  expect(diaryCheck('The position feels balanced after the exchanges.', -4)).toContain('4 down');
  expect(diaryCheck('I am down a piece, but the position feels balanced.', -4)).toBe(null);
  expect(diaryCheck('Balanced.', -2)).toBe(null);
  expect(diaryCheck("I'm losing here.", 5)).toContain('5 up');
});
