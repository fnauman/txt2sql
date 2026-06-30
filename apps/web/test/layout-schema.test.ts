import assert from 'node:assert/strict';
import test from 'node:test';

import { validateLayout } from '../src/client/lib/layout-schema.ts';
import type { QueryResponse } from '../src/client/types.ts';

const result = { visualizations: [{ id: 'v1' }] } as unknown as QueryResponse;

test('accepts a well-formed spec', () => {
  const spec = validateLayout({ version: 1, blocks: [{ id: 'a', type: 'kpiStrip', width: 'full' }] }, result);
  assert.ok(spec);
  assert.equal(spec.blocks.length, 1);
});

test('rejects structurally invalid input', () => {
  assert.equal(validateLayout({ blocks: 'nope' }, result), null);
  assert.equal(validateLayout(null, result), null);
  assert.equal(validateLayout({ version: 1, blocks: [{ id: 'a', type: 'bogus' }] }, result), null);
});

test('drops a chart block referencing a missing visualization', () => {
  const spec = validateLayout(
    { version: 1, blocks: [{ id: 'c', type: 'chart', visualizationId: 'missing' }, { id: 't', type: 'table' }] },
    result
  );
  assert.ok(spec);
  assert.deepEqual(spec.blocks.map((block) => block.type), ['table']);
});

test('keeps a chart block referencing an existing visualization', () => {
  const spec = validateLayout({ version: 1, blocks: [{ id: 'c', type: 'chart', visualizationId: 'v1' }] }, result);
  assert.ok(spec);
  assert.equal(spec.blocks[0].type, 'chart');
});
