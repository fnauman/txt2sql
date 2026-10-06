import assert from 'node:assert/strict';
import test from 'node:test';

import { csvField, errorStageLabel, formatCurrency, formatRowCount, formatValue, friendlyError } from '../src/client/format.ts';

test('formatValue handles empties, numbers, booleans, and text', () => {
  assert.equal(formatValue(null), '-');
  assert.equal(formatValue(undefined), '-');
  assert.equal(formatValue(''), '-');
  assert.equal(formatValue(1000), '1,000');
  assert.equal(formatValue(12.5), '12.5');
  assert.equal(formatValue(true), 'Yes');
  assert.equal(formatValue(false), 'No');
  assert.equal(formatValue('Acme'), 'Acme');
});

test('formatCurrency renders currency or a dash', () => {
  assert.ok(formatCurrency(1.5, 'USD').includes('$'));
  assert.equal(formatCurrency(undefined), '-');
});

test('csvField quotes only when needed and escapes quotes', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('line\nbreak'), '"line\nbreak"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField(null), '');
});

test('friendlyError classifies on the error code first', () => {
  assert.match(friendlyError('anything', { code: 'DB_SCHEMA_MISSING', stage: 'infra' }), /not fully set up/i);
  assert.match(friendlyError('anything', { code: 'RATE_LIMITED' }), /wait a moment/i);
  assert.match(friendlyError('anything', { code: 'UNAUTHORIZED' }), /not authorized/i);
  assert.match(friendlyError('x', { code: 'LLM_TRUNCATED', stage: 'llm' }), /ran out of room/i);
  assert.match(friendlyError('x', { code: 'LLM_REFUSED', stage: 'llm' }), /declined/i);
  assert.match(friendlyError('x', { code: 'LLM_TIMEOUT', stage: 'llm' }), /not responding/i);
  assert.match(friendlyError('x', { code: 'HTTP_503', stage: 'llm' }), /not responding/i);
  // Mirrors isLlmUnavailableCode: a wrong endpoint or model name.
  assert.match(friendlyError('x', { code: 'HTTP_404', stage: 'llm' }), /not responding/i);
  assert.match(friendlyError('x', { code: 'LLM_MODEL_NOT_FOUND', stage: 'llm' }), /not responding/i);
  assert.match(friendlyError('x', { code: 'ER_STATEMENT_TIMEOUT', stage: 'execution' }), /took too long/i);
  assert.match(friendlyError('x', { code: 'REQUEST_TIMEOUT', stage: 'aborted' }), /longer than the server allows/i);
  assert.match(friendlyError('x', { code: 'QUERY_ABORTED', stage: 'aborted' }), /cancelled/i);
  assert.match(friendlyError('x', { code: 'OPENAI_NOT_CONFIGURED', stage: 'infra' }), /no API key/i);
  // Already user-actionable messages are passed through unchanged.
  assert.equal(
    friendlyError('Question must be 2000 characters or fewer.', { code: 'QUESTION_TOO_LONG' }),
    'Question must be 2000 characters or fewer.'
  );
});

test('friendlyError classifies validation failures on the layer, not the message', () => {
  // The message text would not match any fallback pattern; the layer decides.
  assert.match(friendlyError('SQL comments are not welcome', { code: 'SQL_COMMENT', stage: 'validation', layer: 'safety' }), /safe, read-only/i);
  assert.match(friendlyError('Fan-out detected', { code: 'FAN_OUT', stage: 'validation', layer: 'guardrail' }), /valid query/i);
  // A message that reads like a safety rejection does not override the layer.
  assert.match(friendlyError('Only read-only SQL is allowed.', { stage: 'validation', layer: 'guardrail' }), /valid query/i);
  // Validation stage with no layer (older server) still reads as a guardrail failure.
  assert.match(friendlyError('whatever', { stage: 'validation' }), /valid query/i);
});

test('friendlyError falls back to the stage, then to the message text', () => {
  assert.match(friendlyError('ER_PARSE_ERROR near ...', { code: 'ER_PARSE_ERROR', stage: 'execution' }), /database could not run/i);
  assert.match(friendlyError('x', { stage: 'infra' }), /not available right now/i);
  assert.match(friendlyError('x', { stage: 'llm' }), /model could not produce/i);
  // No structured context: the message text decides.
  assert.match(friendlyError('Database "demo_retail" is missing expected demo tables. Missing: Brand'), /not fully set up/i);
  assert.match(friendlyError('SQL references table "X" which is outside the allowed table set.'), /valid query/i);
  assert.match(friendlyError('Only read-only SQL is allowed.'), /safe, read-only/i);
  assert.match(friendlyError('Failed to fetch'), /reach the query service/i);
  assert.match(friendlyError('Could not reach the query service.'), /reach the query service/i);
  assert.match(friendlyError('Too many requests. Please wait 5s'), /wait a moment/i);
  assert.equal(friendlyError('Question must be 2000 characters or fewer.'), 'Question must be 2000 characters or fewer.');
  // Never returns an empty string.
  assert.ok(friendlyError('').length > 0);
  assert.ok(friendlyError(null).length > 0);
  assert.ok(friendlyError(undefined, { code: 'QUESTION_TOO_LONG' }).length > 0);
});

test('formatRowCount shows "N+" when the server cap truncated the result', () => {
  assert.equal(formatRowCount({ rowCount: 1000, totalRowCount: null, truncated: true }), '1,000+');
  assert.equal(formatRowCount({ rowCount: 12, totalRowCount: 12, truncated: false }), '12');
  // An explicit LIMIT above the cap gives an exact total.
  assert.equal(formatRowCount({ rowCount: 1000, totalRowCount: 5000, truncated: true }), '5,000');
  assert.equal(formatRowCount({ rowCount: 0, totalRowCount: null, truncated: false }), '0');
});

test('errorStageLabel names the stage a question failed in', () => {
  assert.equal(errorStageLabel('validation'), 'Blocked by guardrails');
  assert.equal(errorStageLabel('llm'), 'Model');
  assert.equal(errorStageLabel('execution'), 'Database error');
  assert.equal(errorStageLabel('aborted'), 'Cancelled');
  assert.equal(errorStageLabel('infra'), 'Service unavailable');
  assert.equal(errorStageLabel(null), null);
  assert.equal(errorStageLabel(undefined), null);
});
