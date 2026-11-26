// @ts-check
// Paper-derived prompt renderers, kept separate from transport and budgets.
// Compare their output against the released Python functions in the offline fixture.
//
// Adapted from FirmBench (EnterpriseBench), https://github.com/sduyangmin/FirmBench
// at commit fe0edb02bfa298c0f407468255e2dbdf73f4b65b (Consulting/, Agents/discussion/),
// Apache License 2.0; rewritten in JavaScript for this runner.
const END = '<|CASE_INTERVIEW_END|>';
/** @param {{ role: string, content: string }[]} history */
const dialogue = history => history.map(x => `${x.role}: ${x.content}`).join('\n') || '[no previous dialogue]';

/** @param {string} caseText @param {string} opening @param {{ role: string, content: string }[]} history @param {number} remaining */
function interviewerUser(caseText, opening, history, remaining) {
  const lines = history.map(x => `${x.role.toUpperCase()}: ${x.content}`).join('\n') || '(no dialogue yet)';
  return 'You are running a consulting case interview.\n\n'
    + '=== CASE TEXT (only you can see) ===\n' + caseText + '\n\n'
    + '=== OPENING / INITIAL DESCRIPTION ===\n' + opening + '\n\n'
    + '=== DIALOGUE SO FAR ===\n' + lines + '\n\n'
    + 'Now produce your NEXT TURN as the interviewer.\n'
    + `- Maximum remaining turns (including this one) is ${remaining}.\n`
    + '- Keep this turn concise: no more than 500 words.\n'
    + '- If this is the first turn, briefly introduce the case and ask the candidate to structure the problem.\n'
    + `- If you believe you have seen enough and want to end the interview, you MUST include the exact token ${END} in your reply, then give a short closing remark.\n`
    + 'Do NOT mention that you can see the full case text.';
}

/** @param {string} caseId @param {{ role: string, content: string }[]} history */
function cotUser(caseId, history) {
  const question = [...history].reverse().find(x => x.role === 'interviewer')?.content || '[no interviewer message found]';
  return `Current case ID: ${caseId}\n\nDialogue so far (Interviewer / Candidate):\n${dialogue(history)}\n\n`
    + `Interviewer just said:\n${question}\n\nNow respond with your next candidate message, wrapped in JSON as {"reply": "..."}.`
    + '\n\nBefore responding, think step-by-step in private to plan a structured consulting answer. '
    + 'Do NOT reveal your chain-of-thought. Output ONLY a JSON object {"reply": "..."}.';
}

/** @param {number} expertId @param {string} question @param {string} context */
function expertUser(expertId, question, context) {
  return [`You are Expert #${expertId} in a collaborative discussion.`,
    'Your goal: propose a correct solution and final answer.', 'Follow any answer-format instructions inside the question.', '',
    'Return a JSON object with ONLY keys:', '- `reasoning`: your derivation / steps / checks.',
    '- `final_answer`: your proposed final answer (strict format).', '', '', 'Question:', question, '', 'Context:', context, '', 'Respond strictly in JSON.'].join('\n');
}

/** @param {string} question @param {string} context @param {string} proposals */
function moderatorUser(question, context, proposals) {
  return ['You are the MODERATOR of a panel discussion.',
    "You have multiple experts' proposed answers. Your job is to reconcile them and output the best final answer.",
    'Follow any answer-format instructions inside the question.', '', 'Return a JSON object with ONLY keys:',
    '- `reasoning`: the synthesized reasoning and any crucial verification.',
    '- `final_answer`: the definitive final answer (strict format).', '', 'Question:', question, '', 'Context:', context, '',
    "Experts' proposals:", proposals, '', 'Respond strictly in JSON.'].join('\n');
}

module.exports = { interviewerUser, cotUser, expertUser, moderatorUser, dialogue };
