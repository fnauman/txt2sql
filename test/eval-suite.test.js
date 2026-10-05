import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeBenchmarkCase } from '../src/benchmark.js';
import { caseSplit, dedupeSuiteCases, filterSuiteEntries, parseList, scoringFingerprint, selectSuite, suiteName } from '../src/eval/suite.js';

const makeCase = (id, question, sql, extra = {}) => normalizeBenchmarkCase({ id, question, expected_sql: sql, ...extra });

test('de-duplication: same id is one case, same question + gold under another id too', () => {
  const datasets = [
    { name: 'core', cases: [makeCase('c1', 'How many customers?', 'SELECT COUNT(*) FROM Customer'), makeCase('c2', 'Top products?', 'SELECT 1')] },
    {
      name: 'edge',
      cases: [
        makeCase('c1', 'How many customers?', 'SELECT  COUNT(*)\n FROM Customer'),
        makeCase('e1', 'how many customers?', 'SELECT COUNT(*) FROM Customer'),
        makeCase('e2', 'How many customers?', 'SELECT COUNT(*) FROM Customer WHERE IsActive = 1'),
      ],
    },
  ];
  const { entries, duplicates, conflicts } = dedupeSuiteCases(datasets);
  assert.deepEqual(entries.map((entry) => [entry.testCase.id, entry.datasets]), [
    ['c1', ['core', 'edge', 'edge']],
    ['c2', ['core']],
    ['e2', ['edge']],
  ]);
  assert.deepEqual(duplicates.map((entry) => [entry.id, entry.keptAs, entry.reason]), [
    ['c1', 'c1', 'same case id'],
    ['e1', 'c1', 'same question and gold SQL'],
  ]);
  assert.deepEqual(conflicts, []);
});

test('the same id with a different gold, question or scoring is a conflict', () => {
  const datasets = [
    { name: 'a', cases: [makeCase('x', 'Q?', 'SELECT 1'), makeCase('y', 'Q2?', 'SELECT 2'), makeCase('z', 'Q3?', 'SELECT 3')] },
    {
      name: 'b',
      cases: [makeCase('x', 'Q?', 'SELECT 2'), makeCase('y', 'Other?', 'SELECT 2'), makeCase('z', 'Q3?', 'SELECT 3', { comparison: { mode: 'scalar' } })],
    },
  ];
  const { conflicts } = dedupeSuiteCases(datasets);
  assert.deepEqual(conflicts.map((entry) => [entry.id, entry.reason]), [
    ['x', 'different gold SQL'],
    ['y', 'different question'],
    ['z', 'different alternatives or comparison spec'],
  ]);
  assert.notEqual(scoringFingerprint(datasets[0].cases[2]), scoringFingerprint(datasets[1].cases[2]));
});

test('filters: split (missing = dev), case ids, any-of tags, intents', () => {
  const entries = [
    makeCase('a', 'A?', 'SELECT 1', { tags: ['x'], intentId: 'i1' }),
    makeCase('b', 'B?', 'SELECT 2', { tags: ['y'], intentId: 'i2', split: 'holdout' }),
    makeCase('c', 'C?', 'SELECT 3', { tags: ['x', 'z'], intentId: 'i1', split: 'dev' }),
  ].map((testCase) => ({ testCase, datasets: ['d'] }));
  const ids = (list) => list.map((entry) => entry.testCase.id);
  assert.equal(caseSplit(entries[0].testCase), 'dev');
  assert.deepEqual(ids(filterSuiteEntries(entries)), ['a', 'b', 'c']);
  assert.deepEqual(ids(filterSuiteEntries(entries, { split: 'dev' })), ['a', 'c']);
  assert.deepEqual(ids(filterSuiteEntries(entries, { split: 'holdout' })), ['b']);
  assert.deepEqual(ids(filterSuiteEntries(entries, { caseIds: ['c', 'b'] })), ['b', 'c']);
  assert.deepEqual(ids(filterSuiteEntries(entries, { tags: ['y', 'z'] })), ['b', 'c']);
  assert.deepEqual(ids(filterSuiteEntries(entries, { intents: ['i1'] })), ['a', 'c']);
  assert.throws(() => filterSuiteEntries(entries, { split: 'test' }), /--split must be one of dev, holdout, all/);
  assert.deepEqual(parseList('a, b,,a'), ['a', 'b']);
  assert.deepEqual(parseList(null), []);
});

test('the default suite is every committed dataset, de-duplicated to the unique cases', async () => {
  const suite = await selectSuite();
  assert.equal(suite.name, 'all');
  assert.deepEqual(suite.datasets.map((dataset) => dataset.name), ['core-public', 'edge-cases-public', 'paraphrase-public']);
  assert.equal(suite.totalCaseCount, 35);
  assert.equal(suite.uniqueCaseCount, 26);
  assert.equal(suite.entries.length, 26);
  assert.equal(suite.duplicates.length, 9);
  assert.ok(suite.duplicates.every((entry) => entry.reason === 'same case id' && entry.dataset === 'edge-cases-public'));
  assert.equal(new Set(suite.entries.map((entry) => entry.testCase.intentId)).size, 17);

  const edgeOnly = await selectSuite({ datasetNames: ['edge-cases-public'], tags: ['join_path'] });
  assert.equal(edgeOnly.name, 'edge-cases-public');
  assert.deepEqual(edgeOnly.entries.map((entry) => entry.testCase.id), ['edge_public_001_brand_net_sales_march_2026', 'edge_public_002_campaign_net_sales_march_2026']);
  assert.equal(suiteName({ datasetNames: ['a', 'b'] }), 'a+b');
  assert.equal(suiteName({ datasetFiles: ['/x/my-set.json'] }), 'my-set');
});

test('dataset conflicts and empty selections are errors', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'txt2sql-suite-'));
  try {
    await fs.writeFile(path.join(dir, 'a.json'), JSON.stringify([{ id: 'x', question: 'Q?', expected_sql: 'SELECT 1' }]));
    await fs.writeFile(path.join(dir, 'b.json'), JSON.stringify([{ id: 'x', question: 'Q?', expected_sql: 'SELECT 2' }]));
    await assert.rejects(selectSuite({ datasetsDir: dir }), (error) => error.code === 'DATASET_CONFLICT' && /x has a different gold SQL in a and b/.test(error.message));
    await assert.rejects(selectSuite({ datasetsDir: dir, datasetNames: ['a'], tags: ['nope'] }), (error) => error.code === 'EMPTY_SELECTION');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the same question and gold scored differently is a separate case; a dropped id selects its keeper', async () => {
  const datasets = [
    { name: 'd1', cases: [makeCase('a1', 'How many?', 'SELECT 1', { comparison: { mode: 'scalar' } })] },
    {
      name: 'd2',
      cases: [
        // same question and gold, other comparison spec and an alternative gold
        makeCase('b1', 'How  many?', 'SELECT  1', { comparison: { mode: 'rowset', tolerance: 0.5 }, alternative_expected_sql: ['SELECT 1.0'] }),
        // identical in every way that is scored: a duplicate
        makeCase('b2', 'how many?', 'SELECT 1', { comparison: { mode: 'scalar' } }),
      ],
    },
  ];
  const { entries, duplicates } = dedupeSuiteCases(datasets);
  assert.deepEqual(entries.map((entry) => entry.testCase.id), ['a1', 'b1']);
  assert.deepEqual(duplicates.map((entry) => [entry.id, entry.keptAs]), [['b2', 'a1']]);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'txt2sql-suite-'));
  try {
    await fs.writeFile(path.join(dir, 'd1.json'), JSON.stringify([{ id: 'a1', question: 'How many?', expected_sql: 'SELECT 1' }]));
    await fs.writeFile(path.join(dir, 'd2.json'), JSON.stringify([{ id: 'b2', question: 'how many?', expected_sql: 'SELECT 1' }]));
    const suite = await selectSuite({ datasetsDir: dir, caseIds: ['b2'] });
    assert.deepEqual(suite.entries.map((entry) => entry.testCase.id), ['a1']);
    assert.deepEqual(suite.aliasedCaseIds, [{ id: 'b2', keptAs: 'a1' }]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('an id dropped as a question duplicate is still registered: reusing it for another question is a conflict', async () => {
  // a/Q1, then b/Q1 (dropped: same question and gold as a), then b/Q2.
  const datasets = [
    { name: 'd1', cases: [makeCase('a', 'Q1?', 'SELECT 1')] },
    { name: 'd2', cases: [makeCase('b', 'Q1?', 'SELECT 1')] },
    { name: 'd3', cases: [makeCase('b', 'Q2?', 'SELECT 2')] },
  ];
  const { entries, conflicts } = dedupeSuiteCases(datasets);
  assert.deepEqual(conflicts, [{ id: 'b', datasets: ['d2', 'd3'], reason: 'different question and gold SQL' }]);
  assert.deepEqual(entries.map((entry) => entry.testCase.id), ['a'], 'the second b is not kept as a new case');

  // The same dropped id repeated verbatim is one more copy of the kept case.
  const repeated = dedupeSuiteCases([datasets[0], datasets[1], { name: 'd3', cases: [makeCase('b', 'Q1?', 'SELECT  1')] }]);
  assert.deepEqual(repeated.conflicts, []);
  assert.deepEqual(repeated.entries.map((entry) => [entry.testCase.id, entry.datasets]), [['a', ['d1', 'd2', 'd3']]]);
  assert.deepEqual(repeated.duplicates.map((entry) => [entry.id, entry.dataset, entry.keptAs]), [
    ['b', 'd2', 'a'],
    ['b', 'd3', 'a'],
  ]);

  // selectSuite stops the run instead of letting --case-id b pick Q1 or Q2.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'txt2sql-suite-'));
  try {
    await fs.writeFile(path.join(dir, 'd1.json'), JSON.stringify([{ id: 'a', question: 'Q1?', expected_sql: 'SELECT 1' }]));
    await fs.writeFile(path.join(dir, 'd2.json'), JSON.stringify([{ id: 'b', question: 'Q1?', expected_sql: 'SELECT 1' }]));
    await fs.writeFile(path.join(dir, 'd3.json'), JSON.stringify([{ id: 'b', question: 'Q2?', expected_sql: 'SELECT 2' }]));
    await assert.rejects(selectSuite({ datasetsDir: dir, caseIds: ['b'] }), (error) => error.code === 'DATASET_CONFLICT' && /b has a different question and gold SQL in d2 and d3/.test(error.message));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
