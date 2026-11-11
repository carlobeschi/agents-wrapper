// @ts-check
// Ask the agents (ideate.js): parsing replies, labels and clusters, and the
// summary. No agent is called.
const { test, expect } = require('@playwright/test');
const { askPrompt, parseIdeas, anonymise, labelPrompt, parseLabels, parseClusters, summaryMd } = require('../ideate');

const c = { title: 'T', tried: [{ id: 'T1', text: 'debate' }], catalogue: [{ id: 'M1', text: 'fork' }] };

test('ideas, labels and clusters are parsed; the gaps setup sees the pool and the tried list', () => {
  const reply = '**IDEA:** Fork swarm\nMECHANISM: copy the agent\nat step 3.\nNOT HUMAN BECAUSE: people cannot be copied\nCLOSEST HUMAN ANALOGUE: none\nTEST: drawing, score\n\nIDEA: Bad\nTEST: x\n\nIDEA: Mute\nMECHANISM: 4 tokens\nCLOSEST HUMAN ANALOGUE: charades';
  const ideas = parseIdeas(reply);
  expect(ideas).toHaveLength(2);
  expect(ideas[0]).toEqual({ idea: 'Fork swarm', mechanism: 'copy the agent at step 3.', not_human: 'people cannot be copied', analogue: 'none', test: 'drawing, score' });
  expect(askPrompt(c, 'gaps', [{ idea: 'X', mechanism: 'y' }])).toContain('- X: y');
  expect(askPrompt(c, 'gaps', [])).toContain('- debate');
  expect(askPrompt(c, 'plain', [])).not.toContain('- debate');
  expect(askPrompt(c, 'affordances', [])).toContain('forked mid-task');
  expect(anonymise('Claude and GPT-6 met Gemini')).toBe('an agent and an agent met an agent');
  expect(labelPrompt(c, [{ n: 3, idea: 'Claude fork', mechanism: 'm', not_human: 'n' }])).toContain('#3 an agent fork: m');
  expect(parseLabels('#3 | HUMAN: None | ANALOGUE: none | SAME AS: M1, T1 | CHEAP: Yes | WHY: ok.\n**#4** | HUMAN: close | ANALOGUE: meeting | SAME AS: none | CHEAP: no | WHY: x'))
    .toEqual({ 3: { human: 'none', analogue: 'none', same: ['M1', 'T1'], cheap: 'yes', why: 'ok' }, 4: { human: 'close', analogue: 'meeting', same: [], cheap: 'no', why: 'x' } });
  expect(parseClusters('CLUSTER: Forks | IDS: #1, #4 | CORE: copies\nnoise\nCLUSTER: Mute | IDS: 2')).toEqual([{ name: 'Forks', ids: [1, 4], core: 'copies' }, { name: 'Mute', ids: [2], core: '' }]);
});

test('the summary counts verdicts by agent and setup, and lists what is new and not human', () => {
  const ideas = [
    { n: 1, idea: 'Fork', mechanism: 'm1', test: 't', analogue: 'none', agent: 'claude', setup: 'plain' },
    { n: 2, idea: 'Meeting', mechanism: 'm2', test: 't', analogue: 'meeting', agent: 'codex', setup: 'plain' },
  ];
  const labels = { claude: { 1: { human: 'none', same: [], cheap: 'yes' }, 2: { human: 'close', same: ['T1'], cheap: 'yes' } },
    codex: { 1: { human: 'none', same: [], cheap: 'yes' }, 2: { human: 'partial', same: [], cheap: 'no' } } };
  const md = summaryMd(c, ideas, labels, [{ name: 'All', ids: [1, 2], core: 'c' }]);
  expect(md).toContain('| claude | 1 | 100% | 0% | 0% | 0% | 100% | 100% |');
  expect(md).toContain('| codex | 1 | 0% | 100% | 100% | 0% | 0% | 0% |');
  expect(md).toContain('Judge agreement on HUMAN (same label): 1 of 2');
  expect(md).toContain('- **Fork** (claude, plain)');
  expect(md).not.toContain('- **Meeting**');
  expect(md).toContain('| All | 2 | claude, codex | plain | none 1, partial 0, close 1 | c |');
  expect(md).toContain('judged "none" by every judge: 1');
});
