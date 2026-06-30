import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSemanticPlan, tokenVariants } from '../src/pipeline.js';

function layerWithEntitySynonym(synonym) {
  return {
    version: 1,
    entities: [
      {
        name: 'test_entity',
        synonyms: [synonym],
        preferred_tables: ['SalesDocumentLine'],
        display_columns: [],
        preferred_columns: [],
        default_filters: [],
        notes: [],
      },
    ],
    metrics: [],
    filter_hints: [],
    value_aliases: [],
    join_paths: [],
    clarification_rules: [],
  };
}

test('tokenVariants bridges -ed/-ing/-er inflections to a shared stem', () => {
  assert.ok(tokenVariants('moved').has('move'));
  assert.ok(tokenVariants('selling').has('sell'));
  assert.ok(tokenVariants('buyers').has('buyer'));
});

test('tokenVariants does not emit spurious short stems', () => {
  // Suffix stripping must not produce 3-char fragments like "bre" from "bring".
  const bring = tokenVariants('bring');
  assert.ok(!bring.has('bre'));
  for (const variant of bring) {
    // Every variant is either a kept exact form or a >= 4 char stem.
    assert.ok(variant === 'bring' || variant.length >= 4, `unexpected short stem "${variant}"`);
  }
});

test('semantic matching generalizes "moved" to the curated synonym "move"', () => {
  const plan = buildSemanticPlan('which products moved the most this month', {
    semanticLayer: layerWithEntitySynonym('move'),
  });
  assert.equal(plan.entities.length, 1);
  assert.ok(plan.requiredTables.includes('SalesDocumentLine'));
});

test('semantic matching generalizes "selling" to the curated synonym "sell"', () => {
  const plan = buildSemanticPlan('top selling products', {
    semanticLayer: layerWithEntitySynonym('sell'),
  });
  assert.equal(plan.entities.length, 1);
});

test('semantic matching does not match unrelated words', () => {
  const plan = buildSemanticPlan('how many customers are active', {
    semanticLayer: layerWithEntitySynonym('move'),
  });
  assert.equal(plan.entities.length, 0);
});
