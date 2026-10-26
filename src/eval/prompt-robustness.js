// Presentation-only perturbations at the model boundary. Deterministic
// retrieval, temporal resolution, gold SQL, and scoring remain unchanged.
export const ROBUSTNESS_VARIANTS = Object.freeze(['base', 'repeat', 'polite', 'whitespace', 'schema_order']);

export function perturbPromptText(text, variant) {
  if (variant === 'base' || variant === 'repeat') return text;
  if (variant === 'polite' || variant === 'whitespace') {
    return text.replace(/(Question:\n)([\s\S]*?)(\n\nResolved temporal references:)/, (_, start, question, end) =>
      start + (variant === 'polite' ? `Please answer this question: ${question}` : question.replace(/ /g, '  ')) + end
    );
  }
  if (variant !== 'schema_order') throw new Error(`Unknown perturbation: ${variant}`);
  const header = 'In-scope schema:\n';
  const start = text.indexOf(header);
  if (start < 0) return text;
  const offset = start + header.length;
  const questionStart = text.indexOf('\n\nQuestion-specific context:', offset);
  const end = questionStart < 0 ? text.length : questionStart;
  const schema = text.slice(offset, end);
  const trailing = schema.match(/\s*$/)[0];
  const blocks = schema.slice(0, schema.length - trailing.length).split(/\n\n(?=Table )/);
  if (blocks.length < 2 || blocks.some(block => !block.startsWith('Table '))) throw new Error('Expected multiple intact schema table blocks.');
  return text.slice(0, offset) + blocks.reverse().join('\n\n') + trailing + text.slice(end);
}

export function perturbRequest(request, variant) {
  let changed = false;
  const messages = request.messages.map(message => {
    if (message.role !== 'user') return message;
    const transform = text => {
      const result = perturbPromptText(text, variant);
      changed ||= result !== text;
      return result;
    };
    const content = typeof message.content === 'string' ? transform(message.content) :
      message.content.map(block => block.type === 'text' ? { ...block, text: transform(block.text) } : block);
    return { ...message, content };
  });
  if (!['base', 'repeat'].includes(variant) && !changed) throw new Error(`Perturbation did not modify the prompt: ${variant}`);
  return { ...request, messages };
}

export function correctnessState(result) {
  if (!result || result.counted === false || ['infra', 'harness', 'skipped'].includes(result.bucket) || result.timed_out || result.outcome === 'timeout') return null;
  return result.outcome === 'pass';
}

export function summarizeRobustness(records) {
  const rows = records.map(record => ({ id: record.id, states: record.repetitions.map(correctnessState) }));
  const rate = (numerator, denominator) => denominator ? numerator / denominator : null;
  const byVariant = ROBUSTNESS_VARIANTS.map((variant, index) => {
    const eligible = rows.filter(row => row.states[0] !== null && row.states[index] !== null);
    const baselineCorrect = eligible.filter(row => row.states[0]);
    const losses = baselineCorrect.filter(row => !row.states[index]).length;
    const improvements = eligible.filter(row => !row.states[0] && row.states[index]).length;
    const valid = rows.filter(row => row.states[index] !== null);
    return { variant, valid: valid.length, correct: valid.filter(row => row.states[index]).length,
      accuracy: rate(valid.filter(row => row.states[index]).length, valid.length),
      baselineCorrect: baselineCorrect.length, losses, improvements,
      conditionalWrongRate: rate(losses, baselineCorrect.length),
      correctnessFlips: losses + improvements };
  });
  const complete = rows.filter(row => row.states.every(state => state !== null));
  const baseCorrect = complete.filter(row => row.states[0]);
  const stableBaseCorrect = complete.filter(row => row.states[0] && row.states[1]);
  return {
    cases: rows.length, completeCases: complete.length, byVariant,
    unchangedRepeatFlips: byVariant[1].correctnessFlips,
    allFiveCorrect: complete.filter(row => row.states.every(Boolean)).length,
    allFiveWrong: complete.filter(row => row.states.every(state => !state)).length,
    mixedCorrectness: complete.filter(row => row.states.some(Boolean) && !row.states.every(Boolean)).length,
    baselineCorrectCases: baseCorrect.length,
    lostUnderAnyTweak: baseCorrect.filter(row => row.states.slice(2).some(state => !state)).length,
    stableBaselineCorrectCases: stableBaseCorrect.length,
    stableBaselineLostUnderAnyTweak: stableBaseCorrect.filter(row => row.states.slice(2).some(state => !state)).length,
    changedPromptCorrect: complete.reduce((sum, row) => sum + row.states.slice(2).filter(Boolean).length, 0),
    changedPromptTrials: complete.length * 3,
  };
}
