// Per-case trace for the benchmark: buffers every event the product loop
// (runOptimizedQuestion) emits so the benchmark can rebuild per-attempt data,
// and forwards each event, tagged with the case context, to the run's trace
// file so the JSONL stays a complete record.

export function createCaseTraceLogger({ forwardTo = null, context = {} } = {}) {
  const events = [];
  return {
    enabled: true,
    events,
    async emit(event, payload = {}) {
      events.push({ timestamp: new Date().toISOString(), event, ...payload });
      if (forwardTo && typeof forwardTo.emit === 'function') {
        await forwardTo.emit(event, { ...context, ...payload });
      }
    },
  };
}

function pickError(error) {
  if (!error) {
    return null;
  }
  return {
    name: error.name || 'Error',
    code: error.code || null,
    ...(error.layer ? { layer: error.layer } : {}),
    message: error.message || '',
  };
}

/**
 * Per-attempt record of one product-loop run, from its trace events:
 * [{ attempt, retry, generatedSql, llm, validation, execution }] where
 * - llm: { ok, durationMs, usage, cost, model, finishReason } or
 *   { ok: false, durationMs, code, error }
 * - validation: { ok: true, durationMs, tablesUsed } or
 *   { ok: false, durationMs, code, layer, message }
 * - execution: { ok: true, durationMs, rowCount, truncated } or
 *   { ok: false, durationMs, stage, code, message }
 * A step that never ran is null.
 */
export function extractAttempts(events) {
  const attempts = new Map();
  const attemptFor = (number) => {
    if (!attempts.has(number)) {
      attempts.set(number, {
        attempt: number,
        retry: number > 1,
        generatedSql: null,
        llm: null,
        validation: null,
        execution: null,
      });
    }
    return attempts.get(number);
  };

  for (const entry of events || []) {
    if (!Number.isInteger(entry?.attempt)) {
      continue;
    }
    const attempt = attemptFor(entry.attempt);
    const durationMs = entry.durationMs ?? null;
    switch (entry.event) {
      case 'llm.completed':
        attempt.generatedSql = entry.response?.cleanedSql ?? null;
        attempt.llm = {
          ok: true,
          durationMs,
          usage: entry.response?.usage ?? null,
          cost: entry.response?.cost ?? null,
          model: entry.response?.model ?? null,
          finishReason: entry.response?.finishReason ?? null,
        };
        break;
      case 'llm.failed':
        attempt.llm = { ok: false, durationMs, code: entry.errorCode ?? entry.error?.code ?? null, error: pickError(entry.error) };
        break;
      case 'sql.validation_failed':
        attempt.generatedSql ??= entry.candidateSql ?? null;
        attempt.validation = {
          ok: false,
          durationMs,
          code: entry.error?.code ?? null,
          layer: entry.error?.layer ?? null,
          message: entry.error?.message ?? '',
        };
        break;
      case 'sql.validated':
        attempt.validation = { ok: true, durationMs, tablesUsed: entry.validation?.tablesUsed ?? [] };
        break;
      case 'sql.executed':
        attempt.execution = { ok: true, durationMs, rowCount: entry.rowCount ?? null, truncated: Boolean(entry.truncated) };
        break;
      case 'sql.execution_failed':
        attempt.execution = {
          ok: false,
          durationMs,
          stage: entry.errorStage ?? 'execution',
          code: entry.error?.code ?? null,
          message: entry.error?.message ?? '',
        };
        break;
      default:
        break;
    }
  }

  return [...attempts.values()].sort((left, right) => left.attempt - right.attempt);
}
