import assert from 'node:assert/strict';
import test from 'node:test';

import {
  initialStreamState,
  parseFrame,
  streamReducer,
  type StreamAction,
} from '../src/client/lib/stream-protocol.ts';

function apply(actions: StreamAction[]) {
  return actions.reduce((state, action) => streamReducer(state, action), initialStreamState());
}

test('parseFrame parses an event/data frame', () => {
  const frame = parseFrame('event: sql\ndata: {"sql":"SELECT 1"}');
  assert.deepEqual(frame, { event: 'sql', data: { sql: 'SELECT 1' } });
});

test('parseFrame returns null for keepalive / comment lines', () => {
  assert.equal(parseFrame(': keepalive'), null);
  assert.equal(parseFrame(''), null);
});

test('parseFrame tolerates malformed data without throwing', () => {
  assert.deepEqual(parseFrame('event: rows\ndata: {not json'), { event: 'rows', data: null });
});

test('@start moves to streaming with the first stage active', () => {
  const state = apply([{ event: '@start', data: { question: 'top customers' } }]);
  assert.equal(state.status, 'streaming');
  assert.equal(state.result.question, 'top customers');
  assert.equal(state.stages.planning, 'active');
  assert.equal(state.stages.shaping, 'idle');
});

test('a stage frame marks earlier stages done and the arrived stage active', () => {
  const state = apply([
    { event: '@start', data: { question: 'q' } },
    { event: 'stage', data: { stage: 'executing' } },
  ]);
  assert.equal(state.stages.planning, 'done');
  assert.equal(state.stages.generating_sql, 'done');
  assert.equal(state.stages.executing, 'active');
  assert.equal(state.stages.shaping, 'idle');
});

test('the happy path assembles a complete result and ends done', () => {
  const state = apply([
    { event: '@start', data: { question: 'q' } },
    { event: 'sql', data: { sql: 'SELECT 1', explanation: 'why' } },
    { event: 'columns', data: { columns: [{ key: 'a', label: 'A' }], totalRowCount: 2, truncated: false } },
    { event: 'rows', data: { rows: [{ a: 1 }, { a: 2 }] } },
    { event: 'viz', data: { visualizations: [] } },
    { event: 'insights', data: { insights: [{ id: 'x' }] } },
    { event: 'metrics', data: { attemptCount: 1, llmCost: { totalCost: 0.001 }, cacheHit: true } },
    { event: 'done' },
  ]);
  assert.equal(state.status, 'done');
  assert.equal(state.result.success, true);
  assert.equal(state.hasSql && state.hasColumns && state.hasRows && state.hasViz && state.hasInsights, true);
  assert.equal(state.result.sql, 'SELECT 1');
  assert.equal(state.result.rowCount, 2);
  assert.equal(state.cacheHit, true);
  assert.equal(state.stages.shaping, 'done');
});

test('an error frame before done resolves to error status, and done preserves it', () => {
  const state = apply([
    { event: '@start', data: { question: 'q' } },
    { event: 'sql', data: { sql: 'SELECT bad' } },
    { event: 'error', data: { message: 'SQL validation failed' } },
    { event: 'done' },
  ]);
  assert.equal(state.status, 'error');
  assert.equal(state.result.success, false);
  assert.equal(state.error, 'SQL validation failed');
});

test('a transport interruption (no terminal frame) surfaces an error', () => {
  const state = apply([
    { event: '@start', data: { question: 'q' } },
    { event: 'sql', data: { sql: 'SELECT 1' } },
    { event: '@transport-error' },
  ]);
  assert.equal(state.status, 'error');
  assert.match(state.error || '', /interrupted/i);
});

test('cancel before any data resets to idle; after columns keeps the partial result', () => {
  const early = apply([{ event: '@start', data: { question: 'q' } }, { event: '@cancelled' }]);
  assert.equal(early.status, 'idle');

  const late = apply([
    { event: '@start', data: { question: 'q' } },
    { event: 'columns', data: { columns: [], totalRowCount: 0, truncated: false } },
    { event: '@cancelled' },
  ]);
  assert.equal(late.status, 'done');
});
