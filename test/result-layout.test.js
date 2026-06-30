import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLayoutSpec } from '../src/result-layout.js';

test('orders kpiStrip, chart(half), table(half) when all are present', () => {
  const spec = buildLayoutSpec({
    insights: [{ id: 'a' }],
    visualizations: [{ id: 'v', confidence: 0.8 }],
    columns: [{ key: 'c' }],
    rows: [{ c: 1 }],
  });
  assert.deepEqual(spec.blocks.map((block) => block.type), ['kpiStrip', 'chart', 'table']);
  assert.equal(spec.blocks.find((block) => block.type === 'chart').width, 'half');
  assert.equal(spec.blocks.find((block) => block.type === 'table').width, 'half');
  assert.equal(spec.confidence, 0.8);
});

test('table spans full width when there is no chart', () => {
  const spec = buildLayoutSpec({ insights: [], visualizations: [], columns: [{ key: 'c' }], rows: [{ c: 1 }] });
  assert.deepEqual(spec.blocks.map((block) => block.type), ['table']);
  assert.equal(spec.blocks[0].width, 'full');
});

test('omits kpiStrip when there are no insights', () => {
  const spec = buildLayoutSpec({ insights: [], visualizations: [{ id: 'v', confidence: 0.5 }], columns: [{ key: 'c' }], rows: [] });
  assert.ok(!spec.blocks.some((block) => block.type === 'kpiStrip'));
});

test('returns an empty block list for an empty result', () => {
  const spec = buildLayoutSpec({ insights: [], visualizations: [], columns: [], rows: [] });
  assert.deepEqual(spec.blocks, []);
});
