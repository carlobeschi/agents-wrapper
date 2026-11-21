// @ts-check
// Study 16, the double diamond (diamond.js), and its elevator task
// (elevator.js), against fake agents: what is checked is the flow (diverge,
// blind votes, shortlist, builds in turns, second vote, refine, hidden days,
// the alone and orchestra arms, resume) and the simulator, not what any real
// agent writes.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { similarity, parseIdeas, parseScores, parseParts, parseFixes, parseFamilies, shuffled, partnerOf, planFor, loadTask, callsFor } = require('../diamond');
const { simulate, evaluate, makeDay, BASELINE } = require('../elevator');

const FAKE = path.join(__dirname, 'fixtures', 'diamond', 'fake.js');
const SHORT = { ticks: 300, intensity: 0.08 };

test('the elevator simulator: the same day every time, the baseline delivers everyone, a controller that does nothing is penalised', () => {
  expect(makeDay({ kind: 'up', seed: 5, ...SHORT })).toEqual(makeDay({ kind: 'up', seed: 5, ...SHORT }));
  const up = makeDay({ kind: 'up', seed: 5, ...SHORT });
  expect(up.filter(p => p.from === 0).length / up.length).toBeGreaterThan(0.7);
  const base = simulate(BASELINE, { kind: 'inter', seed: 3, ...SHORT });
  expect(base.not_delivered).toBe(0);
  expect(base.delivered).toBe(base.people);
  const idle = evaluate('module.exports = { step() { return null; } };', [{ kind: 'inter', seed: 3, ...SHORT }]);
  expect(idle.days[0].not_delivered).toBe(idle.days[0].people);
  expect(idle.gain).toBeLessThan(-100);
  expect(evaluate(BASELINE, [{ kind: 'lunch', seed: 4, ...SHORT }]).gain).toBe(0);
  // No require, no process: the controller runs in a bare context.
  const sneaky = simulate('const fs = require("fs"); module.exports = { step() { return null; } };', { kind: 'up', seed: 1, ...SHORT });
  expect(sneaky.stopped).toMatch(/did not load/);
  const throws = simulate('module.exports = { step(v) { if (v.time === 3) throw new Error("boom"); return null; } };', { kind: 'up', seed: 1, ...SHORT });
  expect(throws.errors).toBe(1);
  expect(throws.first_error).toContain('boom');
});

test('parsing, shuffling, partners, plan and budget', () => {
  expect(parseIdeas('Intro\n**IDEA 1:** Zones\nsplit floors\n\nIDEA 2: Parking\nback to lobby\nIDEA 3: extra', 2)).toEqual(['Zones\nsplit floors', 'Parking\nback to lobby']);
  expect(parseIdeas('just one blob', 2)).toEqual(['just one blob']);
  expect(parseScores('1: 7 - good\n**2:** 3/10 - meh\nIDEA 3 - 11\n4: 5\n4: 9', 4)).toEqual({ 1: 7, 2: 3, 4: 5 });
  expect(parseParts('Plan.\nPART 1: dispatch\n- PART 2: parking\nPART 3: extra', 2)).toEqual(['dispatch', 'parking']);
  expect(parseFixes('FIX 2: faster\nFIX 2: again\nFIX 9: nope\nFIX 1: ok', 3, 5)).toEqual([{ part: 2, fix: 'faster' }, { part: 1, fix: 'ok' }]);
  expect(parseFamilies('FAMILY: 1, 3 | parking\nFAMILY A: 2,4 | zones\nFAMILY: 9', 4)).toEqual([{ ids: [1, 3], name: 'parking' }, { ids: [2, 4], name: 'zones' }]);
  expect(similarity('const a = 1; go(a)', 'const a = 1; go(a)')).toBe(1);
  expect(similarity('alpha beta', 'gamma delta')).toBe(0);
  expect(shuffled([1, 2, 3, 4, 5], 'x')).toEqual(shuffled([1, 2, 3, 4, 5], 'x'));
  expect(shuffled([1, 2, 3, 4, 5], 'x').slice().sort()).toEqual([1, 2, 3, 4, 5]);
  const base = id => ({ base: id.split('#')[0] });
  expect(partnerOf(['claude#1', 'claude#2', 'codex#1'], 'claude#1', base)).toBe('codex#1');
  expect(partnerOf(['claude#1', 'claude#2'], 'claude#2', base)).toBe('claude#1');
  const c = loadTask(path.join(__dirname, '..', 'examples', 'diamond', 'elevator.json'));
  const plan = planFor(c);
  // Five arms with 2 repeats, D-drafts with one.
  expect(plan).toHaveLength(3 * 5 * 2 + 3);
  expect(plan.filter(s => s.arm === 'D-drafts').map(s => s.r)).toEqual([0, 0, 0]);
  expect(new Set(plan.map(s => s.name)).size).toBe(plan.length);
  // Every arm goes first at least once.
  const firsts = new Set();
  for (const s of plan) if (![...firsts].some(f => f.startsWith(`${s.inst.name}|${s.r}|`))) firsts.add(`${s.inst.name}|${s.r}|${s.arm}`);
  expect(new Set([...firsts].map(f => f.split('|')[2])).size).toBe(6);
  // The arms share about the same budget of calls.
  const calls = Object.values(c.arms).map(a => callsFor(c, a));
  expect(Math.max(...calls) - Math.min(...calls)).toBeLessThanOrEqual(3);
  expect(Math.max(...calls)).toBe(42);
  // No hidden day is ever a visible one.
  for (const inst of c.instances) for (const d of inst.hidden) expect(inst.visible.map(v => JSON.stringify(v))).not.toContain(JSON.stringify(d));
});

test('a full run: diamond, alone and orchestra arms; votes ignore one\'s own ideas; hidden days stay hidden; resume runs nothing new', () => {
  test.setTimeout(240000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'diamond-home-'));
  const fake = style => ({ headless: ['node', FAKE, '{prompt}', style] });
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [
    { id: 'claude', label: 'Ann', ...fake('park') }, { id: 'codex', label: 'Bob', ...fake('plain') }, { id: 'antigravity', label: 'Cy', ...fake('plain') },
  ] }));
  const cfg = path.join(home, 'tiny.json');
  fs.writeFileSync(cfg, JSON.stringify({
    title: 'tiny', goal: 'Write the controller.', proof_wrap: ['env'], judges: ['claude', 'codex'],
    instances: [{ name: 'i1', visible: [{ kind: 'up', seed: 2, ...SHORT }], hidden: [{ kind: 'up', seed: 5, ...SHORT }, { kind: 'lunch', seed: 3, ...SHORT }] }],
    arms: {
      'D-mix': { mode: 'diamond', agents: ['claude#1', 'codex#1', 'antigravity#1'] },
      'D-drafts': { mode: 'diamond', agents: ['claude#1', 'codex#1', 'antigravity#1'], share: 'drafts' },
      'N-solo': { mode: 'alone', agents: ['codex#1', 'claude#1'] },
      O: { mode: 'orchestra', lead: 'claude#1', agents: ['codex#1', 'antigravity#1'] },
    },
    repeats: 1, ideas_per_agent: 2, shortlist: 2, build_rounds: 2, alone_rounds: 2, refine_rounds: 1, orchestra_cycles: 1, orchestra_fixers: 2, parallel: 3,
  }));
  const out = path.join(home, 'out');
  const env = { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0' };
  execFileSync('node', [path.join(__dirname, '..', 'diamond.js'), cfg, `--out=${out}`], { env, encoding: 'utf8', timeout: 200000 });
  const rows = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
  expect(rows.map(r => r.name).sort()).toEqual(['i1-D-drafts-r1', 'i1-D-mix-r1', 'i1-N-solo-r1', 'i1-O-r1']);

  const d = rows.find(r => r.arm === 'D-mix');
  expect(d.ideas).toHaveLength(6);
  // Kept: the two ideas the others scored highest. Only Ann's "Park" idea scores 8 from everyone, so it is kept.
  expect(d.ideas.filter(x => x.kept)).toHaveLength(2);
  expect(d.ideas.find(x => /Park/.test(x.text)).kept).toBe(true);
  expect(d.votes1.filter(v => v.own).every(v => v.voter === d.ideas.find(x => x.id === v.idea).author)).toBe(true);
  expect(d.calls).toHaveLength(3 + 3 + 2 * 2 + 3 + 1 + 2);
  const park = d.prototypes.find(p => p.idea === d.ideas.find(x => /Park/.test(x.text)).id);
  expect(park.partner).not.toBe('claude#1');
  expect(d.winner).toBe(park.k);
  expect(typeof d.final_hidden).toBe('number');
  // Two groups named (1-2 and 3) plus three ideas left out, one family each.
  expect(d.families.map(f => f.families)).toEqual([5, 5]);
  // Votes and prompts never name an agent.
  const steps = path.join(out, 'i1-D-mix-r1', 'steps');
  for (const f of fs.readdirSync(steps).filter(f => f.endsWith('.prompt.md'))) expect(fs.readFileSync(path.join(steps, f), 'utf8')).not.toMatch(/\b(Ann|Bob|Cy)\b/);
  // The hidden days are never in a prompt; the visible one is.
  const build = fs.readFileSync(path.join(steps, '3-build-p1-r2.prompt.md'), 'utf8');
  expect(build).toContain('up-2:');
  for (const f of fs.readdirSync(steps).filter(f => f.endsWith('.prompt.md'))) expect(fs.readFileSync(path.join(steps, f), 'utf8')).not.toMatch(/up-5:|lunch-3:/);

  // Without sharing, a builder never sees another prototype; with "drafts", from round 2 it sees their code and results.
  expect(build).not.toContain('OTHER PROTOTYPE');
  expect(d).toMatchObject({ share: 'none' });
  expect(typeof d.similarity_first).toBe('number');
  expect(typeof d.gap_if_picked_by_visible).toBe('number');
  const dd = rows.find(r => r.arm === 'D-drafts');
  expect(dd.share).toBe('drafts');
  const ddSteps = path.join(out, 'i1-D-drafts-r1', 'steps');
  expect(fs.readFileSync(path.join(ddSteps, '3-build-p1-r1.prompt.md'), 'utf8')).not.toContain('OTHER PROTOTYPE');
  const shared = fs.readFileSync(path.join(ddSteps, '3-build-p1-r2.prompt.md'), 'utf8');
  expect(shared).toContain('OTHER PROTOTYPE 1');
  expect(shared).toContain('module.exports');
  expect(shared).not.toMatch(/up-5:|lunch-3:/);
  expect(dd.calls).toHaveLength(d.calls.length);

  const n = rows.find(r => r.arm === 'N-solo');
  expect(n.calls).toHaveLength(2 * 2 + 1);
  expect(n.candidates).toHaveLength(2);
  // The parking controller (Ann's) beats the baseline on the visible day, so it is picked and refined by Ann.
  const annIs = n.candidates.find(x => x.author === 'claude#1');
  expect(n.picked).toBe(annIs.i);
  expect(n.calls.at(-1).agent).toBe('claude-1');

  const o = rows.find(r => r.arm === 'O');
  expect(o.parts).toBe(2);
  expect(o.calls).toHaveLength(1 + 2 + 1 + 1 * (1 + 2 + 1));
  expect(o.versions).toHaveLength(2);

  const summary = fs.readFileSync(path.join(out, 'summary.md'), 'utf8');
  expect(summary).toContain('| D-mix | diamond |');
  expect(summary).toContain('| N-solo | alone |');

  // Again with the same --out: nothing is asked again.
  const before = fs.statSync(path.join(steps, '1-ideas-01.reply.md')).mtimeMs;
  execFileSync('node', [path.join(__dirname, '..', 'diamond.js'), cfg, `--out=${out}`], { env, encoding: 'utf8', timeout: 60000 });
  expect(fs.statSync(path.join(steps, '1-ideas-01.reply.md')).mtimeMs).toBe(before);
  expect(JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'))).toHaveLength(4);
});
