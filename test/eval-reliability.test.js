import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeReliability, wilsonLowerBound } from '../scripts/evaluate.js';

test('wilsonLowerBound discounts small perfect samples', () => {
  const lower = wilsonLowerBound(6, 6);
  assert.ok(lower > 0.5 && lower < 0.7, `expected ~0.6, got ${lower}`);
  assert.equal(wilsonLowerBound(0, 0), 0);
  assert.ok(wilsonLowerBound(600, 600) > 0.99, 'large perfect samples approach 1.0');
});

test('summarizeReliability reports per-run variance and per-case pass rates', () => {
  const perRepetition = [
    {
      repetition: 1,
      total: 2,
      passed: 1,
      failed: 1,
      statusCounts: { pass: 1, result_mismatch: 1 },
      accuracy: 0.5,
      results: [
        { id: 'a', status: 'pass', question: 'qa' },
        { id: 'b', status: 'result_mismatch', question: 'qb' },
      ],
    },
    {
      repetition: 2,
      total: 2,
      passed: 2,
      failed: 0,
      statusCounts: { pass: 2 },
      accuracy: 1,
      results: [
        { id: 'a', status: 'pass', question: 'qa' },
        { id: 'b', status: 'pass', question: 'qb' },
      ],
    },
  ];

  const reliability = summarizeReliability(perRepetition, 2);

  assert.equal(reliability.repeat, 2);
  assert.equal(reliability.minAccuracy, 0.5);
  assert.equal(reliability.maxAccuracy, 1);
  assert.equal(reliability.meanAccuracy, 0.75);
  assert.equal(reliability.allCasesPassedRate, 0.5);
  assert.equal(reliability.totalAttempts, 4);
  assert.equal(reliability.totalPasses, 3);
  assert.equal(reliability.passRate, 0.75);

  const caseB = reliability.perCase.find((entry) => entry.id === 'b');
  assert.equal(caseB.attempts, 2);
  assert.equal(caseB.passes, 1);
  assert.equal(caseB.passRate, 0.5);
});
