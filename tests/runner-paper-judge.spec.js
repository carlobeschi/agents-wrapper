// @ts-check
const { test, expect } = require('@playwright/test');
const { judgeMessages, validateScore } = require('../runner/enterprisebench-judge');

test('benchmark judge receives full case and ordered dialogue, with no closing token', () => {
  const messages = judgeMessages('paper judge prompt', 'CASE including reference solution', [
    { actor: 'Interviewer', text: 'First question' },
    { actor: 'Candidate', text: 'Answer' },
    { actor: 'Interviewer', text: 'Closing <|CASE_INTERVIEW_END|>' }
  ]);
  expect(messages[0]).toEqual({ role: 'system', content: 'paper judge prompt' });
  expect(messages[1].content).toContain('CASE including reference solution');
  expect(messages[1].content).toContain('INTERVIEWER: First question\nCANDIDATE: Answer\nINTERVIEWER: Closing');
  expect(messages[1].content).not.toContain('<|CASE_INTERVIEW_END|>');
});

test('benchmark scores preserve zero and mean, but malformed or truncated responses fail', () => {
  expect(validateScore('{"structure":0,"quant":4,"business_sense":6,"communication":10,"overall":5,"feedback":"ok"}').dimension_mean).toBe(5);
  expect(() => validateScore('{bad')).toThrow('not valid JSON');
  expect(() => validateScore('{"structure":0}', true)).toThrow('truncated');
  expect(() => validateScore('{"structure":11,"quant":4,"business_sense":6,"communication":10,"overall":5,"feedback":"ok"}')).toThrow('invalid structure');
});
