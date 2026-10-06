import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeBenchmarkCase } from '../src/benchmark.js';
import { caseSplit, dedupeSuiteCases, filterSuiteEntries, parseList, resolveCaseIdAliases, scoringFingerprint, selectSuite, suiteName } from '../src/eval/suite.js';

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
  assert.deepEqual(suite.datasets.map((dataset) => dataset.name), ['core-public', 'edge-cases-public', 'hard-cases-public', 'paraphrase-public', 'templated-public']);
  assert.equal(suite.totalCaseCount, 264);
  assert.equal(suite.uniqueCaseCount, 255);
  assert.equal(suite.entries.length, 255);
  assert.equal(suite.duplicates.length, 9);
  assert.ok(suite.duplicates.every((entry) => entry.reason === 'same case id' && entry.dataset === 'edge-cases-public'));
  assert.equal(new Set(suite.entries.map((entry) => entry.testCase.intentId)).size, 140);
  const holdout = await selectSuite({ split: 'holdout' });
  assert.equal(holdout.entries.length, 81);
  assert.equal(new Set(holdout.entries.map((entry) => entry.testCase.intentId)).size, 45);
  assert.equal((await selectSuite({ split: 'dev' })).entries.length, 255 - 81);
  // The pre-existing datasets alone are still the 26 cases over 17 intents.
  const legacy = await selectSuite({ datasetNames: ['core-public', 'paraphrase-public', 'edge-cases-public'] });
  assert.equal(legacy.entries.length, 26);
  assert.equal(new Set(legacy.entries.map((entry) => entry.testCase.intentId)).size, 17);

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

test('resolveCaseIdAliases maps a dropped duplicate\'s id to the kept case (what a rescore filters with)', () => {
  const duplicates = [
    { id: 'zz_alias_001', keptAs: 'core_public_001' },
    { id: 'core_public_002', keptAs: 'core_public_002' }, // same id in two datasets: not an alias
  ];
  assert.deepEqual(resolveCaseIdAliases(['zz_alias_001', 'core_public_003'], duplicates), {
    caseIds: ['core_public_001', 'core_public_003'],
    aliasedCaseIds: [{ id: 'zz_alias_001', keptAs: 'core_public_001' }],
  });
  assert.deepEqual(resolveCaseIdAliases(['zz_alias_001', 'core_public_001'], duplicates).caseIds, ['core_public_001'], 'de-duplicated');
  assert.deepEqual(resolveCaseIdAliases(['core_public_002'], duplicates), { caseIds: ['core_public_002'], aliasedCaseIds: [] });
  assert.deepEqual(resolveCaseIdAliases(), { caseIds: [], aliasedCaseIds: [] });
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

// A duplicate is dropped only when it is the same case: the run (and the
// in-process verification) uses the first definition, so a second one that
// differs in anything the run selects, verifies, scores or reports by would
// be decided by dataset order. Such a difference is a conflict.
test('the same id with different verification metadata, split, validator flag or other case fields is a conflict', async () => {
  const base = { comparison: { mode: 'scalar' }, expected_row_counts: { seed: 1, v2: 1, v3: 1 } };
  const conflictOf = (left, right) => {
    const forward = dedupeSuiteCases([
      { name: 'a', cases: [makeCase('x', 'Q?', 'SELECT 1', { ...base, ...left })] },
      { name: 'b', cases: [makeCase('x', 'Q?', 'SELECT 1', { ...base, ...right })] },
    ]);
    const backward = dedupeSuiteCases([
      { name: 'b', cases: [makeCase('x', 'Q?', 'SELECT 1', { ...base, ...right })] },
      { name: 'a', cases: [makeCase('x', 'Q?', 'SELECT 1', { ...base, ...left })] },
    ]);
    // Dataset order never decides: both orders are the same conflict.
    assert.deepEqual(backward.conflicts.map((entry) => entry.reason), forward.conflicts.map((entry) => entry.reason));
    if (forward.conflicts.length > 0) {
      assert.deepEqual([forward.duplicates, backward.duplicates], [[], []], 'a conflicting definition is not a duplicate');
    } else {
      assert.deepEqual(forward.duplicates.map((entry) => [entry.id, entry.reason]), [['x', 'same case id']]);
    }
    return forward.conflicts.map((entry) => [entry.id, entry.datasets, entry.reason]);
  };
  // Verification metadata (A2): a bad pin or signal check in the second
  // dataset would otherwise never be verified.
  assert.deepEqual(conflictOf({}, { expected_row_counts: { seed: 1, v2: 2, v3: 1 } }), [['x', ['a', 'b'], 'different expected_row_counts']]);
  assert.deepEqual(conflictOf({}, { signal_checks: { min_row_count: 1 } }), [['x', ['a', 'b'], 'different signal_checks']]);
  // Split (A5): split accuracy would depend on the dataset order.
  assert.deepEqual(conflictOf({ split: 'dev' }, { split: 'holdout' }), [['x', ['a', 'b'], 'different split']]);
  assert.deepEqual(conflictOf({}, { split: 'holdout' }), [['x', ['a', 'b'], 'different split']], 'a missing split is dev');
  assert.deepEqual(conflictOf({ split: 'dev' }, {}), [], 'dev and a missing split are the same split');
  // Known validator rejection (A6): it decides whether verification accepts
  // the rejection as a note or stops.
  assert.deepEqual(conflictOf({ known_validator_rejection: 'TABLE_SCOPE' }, {}), [['x', ['a', 'b'], 'different known_validator_rejection']]);
  assert.deepEqual(conflictOf({ known_validator_rejection: 'TABLE_SCOPE' }, { known_validator_rejection: 'FAN_OUT' }), [['x', ['a', 'b'], 'different known_validator_rejection']]);
  // Selection, attribution and report fields: --tag / --intent, retrieval-miss
  // attribution and the recorded case.
  assert.deepEqual(conflictOf({ tags: ['a'] }, { tags: ['b'] }), [['x', ['a', 'b'], 'different tags']]);
  assert.deepEqual(conflictOf({ tags: ['a', 'b'] }, { tags: ['b', 'a'] }), [], 'tag order does not matter');
  assert.deepEqual(conflictOf({ intentId: 'i1' }, { intentId: 'i2' }), [['x', ['a', 'b'], 'different intentId']]);
  assert.deepEqual(conflictOf({ expected_tables: ['Customer'] }, { expected_tables: ['Store'] }), [['x', ['a', 'b'], 'different expected_tables']]);
  assert.deepEqual(conflictOf({ difficulty: 'easy' }, { difficulty: 'hard' }), [['x', ['a', 'b'], 'different difficulty']]);
  assert.deepEqual(
    conflictOf({ split: 'dev', known_validator_rejection: 'TABLE_SCOPE' }, { split: 'holdout', expected_row_counts: { seed: 2 } }),
    [['x', ['a', 'b'], 'different split, known_validator_rejection and expected_row_counts']]
  );
  // Whitespace in the question and gold is still not a difference.
  assert.deepEqual(conflictOf({}, { question: ' Q? ', expected_sql: 'SELECT  1' }), []);

  // selectSuite stops the run, whichever dataset comes first.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'txt2sql-suite-'));
  try {
    await fs.writeFile(path.join(dir, 'a.json'), JSON.stringify([{ id: 'x', question: 'Q?', expected_sql: 'SELECT 1', split: 'dev' }]));
    await fs.writeFile(path.join(dir, 'b.json'), JSON.stringify([{ id: 'x', question: 'Q?', expected_sql: 'SELECT 1', split: 'holdout' }]));
    for (const datasetNames of [['a', 'b'], ['b', 'a']]) {
      await assert.rejects(
        selectSuite({ datasetsDir: dir, datasetNames, split: 'holdout' }),
        (error) => error.code === 'DATASET_CONFLICT' && /x has a different split in (a and b|b and a)/.test(error.message)
      );
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a question duplicate under another id must agree on split and validator flag', () => {
  const conflictsOf = (extraA, extraB) =>
    dedupeSuiteCases([
      { name: 'd1', cases: [makeCase('a', 'Q1?', 'SELECT 1', extraA)] },
      { name: 'd2', cases: [makeCase('b', 'q1?', 'SELECT 1', extraB)] },
    ]);
  const split = conflictsOf({ split: 'dev' }, { split: 'holdout' });
  assert.deepEqual(split.conflicts, [{ id: 'b', datasets: ['d1', 'd2'], reason: 'different split than a (same question and gold SQL)' }]);
  assert.deepEqual([split.entries.map((entry) => entry.testCase.id), split.duplicates], [['a'], []]);
  const flag = conflictsOf({}, { known_validator_rejection: 'TABLE_SCOPE' });
  assert.deepEqual(flag.conflicts, [{ id: 'b', datasets: ['d1', 'd2'], reason: 'different known_validator_rejection than a (same question and gold SQL)' }]);
  // Agreeing on both, the second id is still one more copy of the first.
  const same = conflictsOf({ split: 'holdout', tags: ['t1'] }, { split: 'holdout', tags: ['t2'] });
  assert.deepEqual([same.conflicts, same.duplicates.map((entry) => [entry.id, entry.keptAs])], [[], [['b', 'a']]]);
});
