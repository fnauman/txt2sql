import assert from 'node:assert/strict';
import test from 'node:test';

import { executeReadOnlySql } from '../src/pipeline.js';

// executeReadOnlySql wraps model-authored SQL in `SET STATEMENT max_statement_time`
// — the only tail-bound that stops a pathological generated query from pinning the
// MariaDB instance, which may also host sensitive non-demo databases. These tests
// pin that wrapper (and its ms->s conversion) so it cannot silently regress.
function createRecordingConnection() {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      return [[{ ok: 1 }]];
    },
  };
}

test('executeReadOnlySql wraps SQL with a SET STATEMENT timeout when timeoutMs > 0', async () => {
  const connection = createRecordingConnection();
  const rows = await executeReadOnlySql(connection, 'SELECT 1', { timeoutMs: 8000 });

  assert.deepEqual(rows, [{ ok: 1 }]);
  assert.equal(connection.calls[0], 'SET STATEMENT max_statement_time=8.000 FOR SELECT 1');
});

test('executeReadOnlySql converts fractional milliseconds to seconds', async () => {
  const connection = createRecordingConnection();
  await executeReadOnlySql(connection, 'SELECT 2', { timeoutMs: 500 });

  assert.equal(connection.calls[0], 'SET STATEMENT max_statement_time=0.500 FOR SELECT 2');
});

test('executeReadOnlySql runs the raw SQL when the timeout is zero or omitted', async () => {
  const zeroTimeout = createRecordingConnection();
  await executeReadOnlySql(zeroTimeout, 'SELECT 3', { timeoutMs: 0 });
  assert.equal(zeroTimeout.calls[0], 'SELECT 3');

  const noTimeout = createRecordingConnection();
  await executeReadOnlySql(noTimeout, 'SELECT 4', {});
  assert.equal(noTimeout.calls[0], 'SELECT 4');
});
