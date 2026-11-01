// Versioned independently of historical hints and oracle recordings.
export const RESPONSE_CONTRACT_VERSION = 2;

export const DECISION_POLICY = `Decide whether the available schema and business rules support the request before writing SQL.
Use decision "clarify" when a missing metric, date basis, entity or filter materially changes the answer and no documented default resolves it. Ask specific clarification_questions; do not guess that business meaning.
Use decision "abstain" when the requested facts or operation cannot be supported by the allowed schema or read-only SQL. Explain the limitation without fabricating data or relationships.
Use decision "answer" for a supported, sufficiently specified request. Apply documented defaults; do not ask about a convention already resolved by the question or business rules.
For clarify or abstain, sql must be an empty string, tables_used and assumptions must be empty arrays, and explanation must explain what is needed. Only clarify has nonempty clarification_questions. Do not include executable SQL in a non-answer.`;

export function responseDecision(parsed) {
  // Old recordings and simple compatible gateways can still return the v1
  // answer shape. An explicit malformed decision must never fall back to SQL.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('The model response must be an object.'), { code: 'LLM_INVALID_DECISION' });
  }
  const decision = Object.hasOwn(parsed, 'decision') ? parsed.decision : 'answer';
  const questions = parsed.clarification_questions ?? [];
  const invalid = !['answer', 'clarify', 'abstain'].includes(decision) ||
    (Object.hasOwn(parsed, 'decision') && decision === 'answer' &&
      (typeof parsed.sql !== 'string' || !parsed.sql.trim())) ||
    !Array.isArray(questions) || questions.some(q => typeof q !== 'string' || !q.trim()) ||
    (decision === 'clarify' ? questions.length === 0 : questions.length !== 0) ||
    (decision !== 'answer' && (typeof parsed.sql !== 'string' || parsed.sql.trim() !== '' ||
      typeof parsed.explanation !== 'string' || !parsed.explanation.trim() ||
      !Array.isArray(parsed.tables_used) || parsed.tables_used.length !== 0 ||
      !Array.isArray(parsed.assumptions) || parsed.assumptions.length !== 0));
  if (invalid) {
    throw Object.assign(new Error('The model returned an inconsistent response decision.'), { code: 'LLM_INVALID_DECISION' });
  }
  return { decision, clarificationQuestions: questions.map(q => q.trim()) };
}
