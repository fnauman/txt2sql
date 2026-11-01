// Preserve old prompt fixtures as historical evidence. The version-2 response
// contract deliberately changes only these shared instructions; schema scope,
// question context, retrieval and hints remain pinned by the old fixtures.
import { DECISION_POLICY } from '../../src/response-decision.js';

export function upgradeLegacyPrompt(system) {
  return system
    .replace('Write one read-only SQL query using only the provided schema context.', 'Write one read-only SQL query for an answer, or request clarification / abstain without SQL.')
    .replace('If the business meaning is ambiguous, choose the most directly named column and state that assumption in the JSON response.', 'If materially different business meanings remain after applying documented defaults, ask for clarification before generating SQL.')
    .replace('Return ONLY a JSON object', `${DECISION_POLICY}\n\nReturn ONLY a JSON object`)
    .replace('  "sql": "SELECT ...",', '  "decision": "answer",\n  "clarification_questions": [],\n  "sql": "SELECT ...",');
}
