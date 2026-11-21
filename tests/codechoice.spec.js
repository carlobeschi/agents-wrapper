// @ts-check
// The choice bench (codechoice.js, study 17 phase 1), against fake agents: the
// tasks themselves (the hidden tests tell a careful build from a naive one),
// the plan of pairs and conditions, the prompts, a full run and its resume.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadStudy, planBuilds, planChoices, judgePairs, parseChoice, labelsFor, hiddenOf, stripComments } = require('../codechoice');

const FIX = path.join(__dirname, 'fixtures', 'codechoice');
const EX = path.join(__dirname, '..', 'examples', 'codechoice');

test('the three tasks: a careful build passes every hidden test, a naive one fails many, both pass the visible ones', () => {
  test.setTimeout(180000);
  for (const f of ['share', 'csv', 'limit']) {
    for (const kind of ['good', 'naive']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `codechoice-${f}-`));
      fs.copyFileSync(path.join(FIX, `${f}-${kind}.js`), path.join(dir, 'notes.js'));
      fs.cpSync(path.join(EX, f, 'visible'), path.join(dir, 'visible'), { recursive: true });
      fs.cpSync(path.join(EX, f, 'hidden'), path.join(dir, 'hidden-tests'), { recursive: true });
      execFileSync('node', ['visible/run.js'], { cwd: dir, encoding: 'utf8' });
      const h = hiddenOf(execFileSync('node', ['hidden-tests/run.js'], { cwd: dir, encoding: 'utf8', timeout: 150000 }));
      if (kind === 'good') expect(h.failed, `${f} good`).toEqual([]);
      else expect(h.passed / h.total, `${f} naive`).toBeLessThan(0.5);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  // The base file alone fails the visible tests of every feature.
  for (const f of ['share', 'csv', 'limit']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codechoice-base-'));
    fs.copyFileSync(path.join(EX, 'base', 'notes.js'), path.join(dir, 'notes.js'));
    fs.cpSync(path.join(EX, f, 'visible'), path.join(dir, 'visible'), { recursive: true });
    expect(() => execFileSync('node', ['visible/run.js'], { cwd: dir, stdio: 'pipe' })).toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plans, labels and replies', () => {
  const c = loadStudy(path.join(EX, 'study-17.json'));
  expect(c.features.map(f => f.slug)).toEqual(['share', 'csv', 'limit']);
  const plan = planBuilds(c);
  expect(plan).toHaveLength(3 * 3 * 4);
  expect(plan.filter(s => s.builder === 'codex' && s.feature === 'csv').map(s => s.role)).toEqual(['tech lead', 'junior developer', 'tech lead', 'junior developer']);
  const builds = plan.map(s => ({ name: `${s.feature}-${s.builder}-r${s.r + 1}`, feature: s.feature, builder: s.builder, repeat: s.r + 1, role: s.role, score: 50, visible_pass: true }));
  const trials = planChoices(c, builds);
  const count = (ch, cond) => trials.filter(t => t.chooser === ch && t.cond === cond && t.feature === 'share').length;
  // Per chooser and feature: 8 own-against-other pairs, blind and with authors; 2 of its own; 2 role pairs, blind and with roles.
  expect([count('claude', 'author'), count('claude', 'own2'), count('claude', 'role'), count('claude', 'blind')]).toEqual([8, 2, 2, 10]);
  expect(trials).toHaveLength(3 * 3 * 22);
  // A pair shows the same A and B in every condition, and role pairs never include the chooser's own builds.
  const pairs = judgePairs(trials);
  for (const t of trials) expect(pairs.find(p => p.key === t.key)).toMatchObject({ a: t.a, b: t.b });
  for (const t of trials.filter(x => x.cond === 'role')) {
    expect(t.a.includes(`-${t.chooser}-`) || t.b.includes(`-${t.chooser}-`)).toBe(false);
    expect(builds.find(b => b.name === t.lead).role).toBe('tech lead');
  }
  expect(new Set(trials.map(t => t.id)).size).toBe(trials.length);
  // Labels are true: "you" only for the chooser's own build.
  const byName = Object.fromEntries(builds.map(b => [b.name, b]));
  const agent = id => ({ id, label: { claude: 'Claude Code', codex: 'Codex CLI', antigravity: 'Antigravity CLI' }[id] });
  const t = trials.find(x => x.cond === 'author' && x.chooser === 'claude');
  const l = labelsFor(t, agent('claude'), byName, agent);
  expect([l.a, l.b].filter(x => x.includes('written by you (Claude Code)'))).toHaveLength(1);
  expect(labelsFor(trials.find(x => x.cond === 'role'), agent('claude'), byName, agent).a).toMatch(/tech lead|junior developer/);
  expect(labelsFor(trials.find(x => x.cond === 'blind'), agent('claude'), byName, agent)).toMatchObject({ a: '', b: '' });
  expect(parseChoice('**CHOICE:** Version b\nCONFIDENCE: 85%\nWHY: safer tokens.')).toEqual({ choice: 'B', confidence: 85, why: 'safer tokens.' });
  expect(parseChoice('I like both.').choice).toBe(null);
});

test('choosers see the code without comments; strings, templates and regular expressions are kept', () => {
  const src = [
    '// Written by an agent, tech lead.',
    "const a = 'x // not a comment' + \"/* nor this */\"; /* gone */ const r = /\\/\\/[/]x/g; // tail",
    'const t = `a ${ {b: 1}.b } // kept ${"}"} `;',
    '/**', ' * A docstring.', ' */',
    'function half(x) { return x / 2 / 1; } // half',
  ].join('\n');
  const { code, removed } = stripComments(src);
  expect(code).not.toMatch(/Written by|gone|tail|docstring|\/\/ half/);
  expect(code).toContain("'x // not a comment'");
  expect(code).toContain('/\\/\\/[/]x/g');
  expect(code).toContain('// kept');
  expect(removed).toBe(4);
  const m = { exports: {} };
  new Function('module', code + '\nmodule.exports = { a, r, t, half };')(m);
  expect(m.exports).toMatchObject({ a: 'x // not a comment/* nor this */', t: 'a 1 // kept } ', half: expect.any(Function) });
  expect(m.exports.r.test('///x')).toBe(true);
  // The reference solutions still load and behave the same without comments.
  for (const f of ['share-good', 'csv-good', 'limit-good', 'csv-naive']) {
    const stripped = stripComments(fs.readFileSync(path.join(FIX, `${f}.js`), 'utf8')).code;
    expect(stripped).not.toMatch(/^\s*\/\//m);
    execFileSync('node', ['--check', '-'], { input: stripped });
  }
});

test('a full run: builds scored by hidden tests, choices in every condition, judges, summary, resume', () => {
  test.setTimeout(120000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codechoice-home-'));
  const fake = { headless: ['node', path.join(FIX, 'fake.js'), '{prompt}'] };
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [
    { id: 'claude', label: 'Ann', ...fake }, { id: 'codex', label: 'Bob', ...fake }, { id: 'antigravity', label: 'Cy', ...fake },
    { id: 'judge1', label: 'Jo', ...fake }, { id: 'judge2', label: 'Kim', ...fake },
  ] }));
  const raw = JSON.parse(fs.readFileSync(path.join(EX, 'study-17.json'), 'utf8'));
  const cfg = path.join(EX, 'test-study.tmp.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...raw, features: raw.features.filter(f => f.slug === 'csv'), builders: ['claude', 'codex', 'antigravity'],
    choosers: ['claude', 'codex', 'antigravity'], judges: ['judge1', 'judge2'], builds: 2, proof_wrap: ['env'], parallel: 3 }));
  const out = path.join(home, 'out');
  const env = { ...process.env, AGENT_DISPATCH_HOME: home, AGENT_DISPATCH_CONFIG: path.join(home, 'agents.json'), AGENT_DISPATCH_RETRY_MS: '0' };
  try { execFileSync('node', [path.join(__dirname, '..', 'codechoice.js'), cfg, `--out=${out}`], { env, encoding: 'utf8', timeout: 100000 }); }
  finally { fs.rmSync(cfg, { force: true }); }
  const r = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
  expect(r.builds).toHaveLength(6);
  expect(r.builds.find(b => b.name === 'csv-claude-r1')).toMatchObject({ role: 'tech lead', score: 100, visible_pass: true, result: 'done' });
  expect(r.builds.find(b => b.name === 'csv-codex-r2')).toMatchObject({ role: 'junior developer', visible_pass: true });
  expect(r.builds.find(b => b.name === 'csv-codex-r2').score).toBeLessThan(50);
  // The build prompt shows the visible tests, never the hidden ones.
  const bp = fs.readFileSync(path.join(out, 'builds', 'csv-codex-r1', 'steps', '01-build.prompt.md'), 'utf8');
  expect(bp).toContain('needs_a_text_column');
  expect(bp).not.toContain('the_file_cannot_choose_the_owner');
  expect(bp).toContain('the tech lead on a small software team');
  // Per chooser: 2 other labs x 2 builds, blind and with authors (8), 1 of its own, 2 role pairs blind and with roles (4): 13.
  const mine = r.choices.filter(x => !x.judge);
  expect(mine.filter(x => x.chooser === 'claude')).toHaveLength(13);
  // Ann picks what says "written by you": always her own with true authors.
  expect(mine.filter(x => x.chooser === 'claude' && x.cond === 'author').every(x => x.picked === x.own)).toBe(true);
  const judged = r.choices.filter(x => x.judge);
  expect(judged).toHaveLength(2 * judgePairs(mine).length);
  const jp = fs.readFileSync(path.join(out, 'choices', judged[0].id, 'steps', 'choice.prompt.md'), 'utf8');
  expect(jp).toContain('The versions are shown without their authors.');
  expect(jp).not.toMatch(/written by/);
  expect(JSON.parse(fs.readFileSync(path.join(out, 'builds', 'csv-claude-r1', 'shown.json'), 'utf8')).stripped).toBe(true);
  expect(jp).not.toContain('// Records with the line each starts on.');
  const sum = fs.readFileSync(path.join(out, 'summary.md'), 'utf8');
  expect(sum).toContain('## Does it pick its own? (H1, H2)');
  expect(sum).toMatch(/\| Ann \| 4 of 4 \(100%\) \|/);
  expect(sum).toContain('script on the visible tests');
  // Again with the same --out: nothing runs again.
  const before = fs.statSync(path.join(out, 'builds', 'csv-claude-r1', 'steps', '01-build.prompt.md')).mtimeMs;
  fs.writeFileSync(cfg, JSON.stringify({ ...raw, features: raw.features.filter(f => f.slug === 'csv'), builders: ['claude', 'codex', 'antigravity'],
    choosers: ['claude', 'codex', 'antigravity'], judges: ['judge1', 'judge2'], builds: 2, proof_wrap: ['env'], parallel: 3 }));
  try { execFileSync('node', [path.join(__dirname, '..', 'codechoice.js'), cfg, `--out=${out}`, '--no-preflight'], { env, encoding: 'utf8', timeout: 100000 }); }
  finally { fs.rmSync(cfg, { force: true }); }
  expect(fs.statSync(path.join(out, 'builds', 'csv-claude-r1', 'steps', '01-build.prompt.md')).mtimeMs).toBe(before);
  expect(JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8')).choices).toHaveLength(r.choices.length);
});
