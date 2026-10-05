import assert from 'node:assert/strict';
import test from 'node:test';

import { FACT_TABLES, MASTER_DATA, MASTER_TABLES, SEED_FACTS } from '../src/eval/fixture-data.js';
import {
  FIXTURES,
  PRIMARY_FIXTURE,
  V3_PRNG_SEED,
  buildFixtureRows,
  buildV2Facts,
  describeFixtureContent,
  fixtureContentHash,
  generateV3Facts,
  resolveFixtures,
} from '../src/eval/fixtures.js';
import { createPrng } from '../src/eval/prng.js';
import { expandProductSearchTerms, rankProductCandidates } from '../src/master-data-resolver.js';

// Content hashes of the committed fixtures. The dataset pins
// (expected_row_counts) and the controls were verified against exactly this
// content; a change here means re-running `npm run seed-fixtures` and
// `npm run verify-dataset -- --write-pins`, and bumping
// FIXTURE_GENERATOR_VERSION when the change is intentional.
const EXPECTED_CONTENT_HASHES = {
  seed: 'ca59bf9a1a49726c',
  v2: '622fceca5155e7d5',
  v3: '5f2b531b13a0c379',
};

const isMarch2026 = (date) => date >= '2026-03-01' && date < '2026-04-01';

test('three fixtures, seed first, all in the demo_retail* grant scope', () => {
  assert.deepEqual(
    FIXTURES.map(({ name, database }) => ({ name, database })),
    [
      { name: 'seed', database: 'demo_retail' },
      { name: 'v2', database: 'demo_retail_v2' },
      { name: 'v3', database: 'demo_retail_v3' },
    ]
  );
  assert.equal(PRIMARY_FIXTURE.name, 'seed');
  assert.deepEqual(resolveFixtures('v3, seed').map((fixture) => fixture.name), ['seed', 'v3']);
  assert.deepEqual(resolveFixtures(null).map((fixture) => fixture.name), ['seed', 'v2', 'v3']);
  assert.throws(() => resolveFixtures('v9'), /Unknown fixture "v9"/);
});

test('every fixture carries identical master data and differs only in facts', () => {
  const built = Object.fromEntries(FIXTURES.map((fixture) => [fixture.name, buildFixtureRows(fixture.name)]));
  for (const table of MASTER_TABLES) {
    assert.deepEqual(built.v2[table], built.seed[table], `${table} differs between seed and v2`);
    assert.deepEqual(built.v3[table], built.seed[table], `${table} differs between seed and v3`);
    assert.deepEqual(built.seed[table], MASTER_DATA[table].map((row) => ({ ...row })));
  }
  for (const table of FACT_TABLES) {
    assert.notDeepEqual(built.v2[table], built.seed[table]);
    assert.notDeepEqual(built.v3[table], built.seed[table]);
  }
  assert.deepEqual(built.seed.SalesDocument, SEED_FACTS.SalesDocument.map((row) => ({ ...row })), 'the seed keeps its original facts');
});

test('generation is deterministic: same seed, same content hash (no database needed)', () => {
  for (const fixture of FIXTURES) {
    const first = describeFixtureContent(fixture.name);
    const second = describeFixtureContent(fixture.name);
    assert.equal(first.contentHash, second.contentHash);
    assert.equal(first.contentHash.slice(0, 16), EXPECTED_CONTENT_HASHES[fixture.name], `${fixture.name} content changed`);
  }

  const withSeed = (seed) => fixtureContentHash({ ...MASTER_DATA, ...generateV3Facts({ seed }) });
  assert.equal(withSeed(V3_PRNG_SEED), describeFixtureContent('v3').contentHash);
  assert.equal(withSeed(V3_PRNG_SEED), withSeed(V3_PRNG_SEED));
  assert.notEqual(withSeed(V3_PRNG_SEED + 1), withSeed(V3_PRNG_SEED));
});

test('the PRNG is reproducible and stays in range', () => {
  const left = createPrng(42);
  const right = createPrng(42);
  const draws = Array.from({ length: 1000 }, () => left.next());
  assert.deepEqual(Array.from({ length: 1000 }, () => right.next()), draws);
  assert.ok(draws.every((value) => value >= 0 && value < 1));
  const ints = createPrng(7);
  assert.ok(Array.from({ length: 500 }, () => ints.int(3, 5)).every((value) => value >= 3 && value <= 5));
  assert.equal(createPrng(1).weighted([['only', 1]]), 'only');
});

test('v2 ports the audit fixture: separated metrics, header discounts, boundary dates, NULLs', () => {
  const facts = buildV2Facts();
  const documents = new Map(facts.SalesDocument.map((row) => [row.SalesDocumentId, row]));
  const linesOf = (id) => facts.SalesDocumentLine.filter((line) => line.SalesDocumentId === id);

  assert.equal(facts.SalesDocument.length, 23);
  assert.equal(facts.SalesDocumentLine.length, 33);
  assert.equal(facts.AccountingPosting.length, 27);
  for (const document of facts.SalesDocument) {
    assert.ok(Math.abs(document.NetPayableAmount - document.NetAmount - 12.5) < 1e-9, `doc ${document.SalesDocumentId} NetPayable`);
    assert.ok(Math.abs(document.BillTotalAmount - document.GrossAmount - 7.25) < 1e-9, `doc ${document.SalesDocumentId} BillTotal`);
  }
  assert.equal(documents.get(2).NetAmount, 845);
  assert.equal(linesOf(2).reduce((sum, line) => sum + line.NetAmount, 0), 860);
  assert.ok(facts.SalesDocumentLine.filter((line) => line.TotalAmount !== line.NetAmount).length >= 30);
  assert.equal(documents.get(13).DocumentDate, '2026-03-31');
  assert.equal(documents.get(13).PostingDate, '2026-04-01');
  assert.ok(facts.SalesDocumentLine.some((line) => line.ProductId === null));
  assert.ok(facts.AccountingPosting.some((posting) => posting.SalesDocumentId === null));
  assert.ok(facts.AccountingPosting.some((posting) => posting.SalesDocumentId === 10), 'a canceled document with postings');
  assert.equal(documents.get(10).IsCanceled, 1);
  assert.ok(facts.SalesDocument.some((document) => document.DocumentDate.startsWith('2025-03')));
  assert.equal(documents.get(21).CampaignId, null);
  assert.equal(documents.get(23).CustomerId, 8, 'the second Summit Grocers buys in February');
  assert.ok(facts.SalesDocumentLine.some((line) => line.NetAmount === 129.935), 'sub-cent amounts');
});

test('v3 is a large seeded fact set with the traps the oracle needs', () => {
  const facts = generateV3Facts();
  const documents = facts.SalesDocument;
  const byId = new Map(documents.map((document) => [document.SalesDocumentId, document]));
  const lines = facts.SalesDocumentLine;

  assert.ok(documents.length >= 150 && documents.length <= 300, `${documents.length} documents`);
  assert.ok(lines.length >= 2 * documents.length, 'multiple lines per document on average');
  const months = new Set(documents.map((document) => document.DocumentDate.slice(0, 7)));
  assert.deepEqual([...months].sort(), ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05']);

  // Boundary days, and posting dates that fall in the next month.
  for (const month of months) {
    const dates = documents.filter((document) => document.DocumentDate.startsWith(month)).map((document) => document.DocumentDate);
    assert.ok(dates.includes(`${month}-01`), `${month} has a first-day document`);
    const last = [...dates].sort().at(-1);
    assert.ok(Number(last.slice(8)) >= 28, `${month} has a last-day document`);
  }
  assert.ok(documents.filter((document) => document.PostingDate.slice(0, 7) !== document.DocumentDate.slice(0, 7)).length >= 5);

  // Cancellations (some posted), NULLs, stale snapshots, manual journals.
  const canceled = documents.filter((document) => document.IsCanceled === 1);
  assert.ok(canceled.length >= 5);
  assert.ok(canceled.some((document) => isMarch2026(document.DocumentDate)));
  assert.ok(facts.AccountingPosting.some((posting) => byId.get(posting.SalesDocumentId)?.IsCanceled === 1));
  assert.ok(facts.AccountingPosting.filter((posting) => posting.SalesDocumentId === null).length >= 2);
  assert.ok(lines.some((line) => line.ProductId === null));
  assert.ok(documents.some((document) => document.CampaignId === null));
  assert.ok(lines.some((line) => line.ProductNameSnapshot === 'Basmati Rice 5kg'));
  assert.ok(lines.some((line) => line.BrandNameSnapshot === 'Northstar Beverages Co'));
  assert.ok(documents.some((document) => !facts.AccountingPosting.some((posting) => posting.SalesDocumentId === document.SalesDocumentId) && document.IsCanceled === 0));
  assert.ok(documents.every((document) => document.CustomerId !== 7), 'Harbor Kiosk never orders');

  // Header metrics all differ somewhere; line Total != Net on most lines.
  const lineNet = (id) => lines.filter((line) => line.SalesDocumentId === id).reduce((sum, line) => sum + line.NetAmount, 0);
  assert.ok(documents.some((document) => Math.abs(document.NetAmount - lineNet(document.SalesDocumentId)) > 0.01));
  assert.ok(documents.filter((document) => document.NetPayableAmount !== document.NetAmount).length > documents.length / 2);
  assert.ok(lines.filter((line) => line.TotalAmount !== line.NetAmount).length > lines.length / 2);

  // March 2026: 11 products sell (a top-10 LIMIT binds) with a clear 10/11 gap.
  const counted = lines.filter((line) => {
    const document = byId.get(line.SalesDocumentId);
    return line.ProductId !== null && document.IsCanceled === 0 && isMarch2026(document.DocumentDate);
  });
  for (const key of ['Quantity', 'NetAmount']) {
    const totals = new Map();
    for (const line of counted) {
      totals.set(line.ProductId, (totals.get(line.ProductId) || 0) + line[key]);
    }
    const sorted = [...totals.values()].sort((left, right) => right - left);
    assert.equal(sorted.length, 11);
    assert.ok(sorted[9] - sorted[10] >= 1, `${key} cut-off gap`);
  }
  assert.ok(!counted.some((line) => line.ProductId === 7), 'Cane Sugar sells in March only on a canceled document');

  // At most one half-cent line per product / category / brand / campaign.
  const halfCent = lines.filter((line) => Math.round(line.NetAmount * 1000) % 10 !== 0);
  assert.equal(halfCent.length, 2);
  const product = (id) => MASTER_DATA.Product.find((row) => row.ProductId === id);
  for (const key of ['ProductCategoryId', 'BrandId', 'CampaignId', 'ProductId']) {
    assert.equal(new Set(halfCent.map((line) => product(line.ProductId)[key])).size, 2, key);
  }

  // A tie on March net sales between two customers.
  const marchNet = new Map();
  for (const document of documents.filter((entry) => entry.IsCanceled === 0 && isMarch2026(entry.DocumentDate))) {
    marchNet.set(document.CustomerId, (marchNet.get(document.CustomerId) || 0) + Math.round(document.NetAmount * 100));
  }
  assert.ok(new Set(marchNet.values()).size < marchNet.size, 'two customers tie');
});

test('master data stays consistent with the semantic layer: sparkling water resolves to the sparkling SKUs only', () => {
  const [group] = expandProductSearchTerms(['sparkling water']);
  const [ranked] = rankProductCandidates(MASTER_DATA.Product, [group]);
  assert.deepEqual(
    ranked.candidates.map((candidate) => candidate.ProductName).sort(),
    ['Lime Seltzer 8 Pack', 'Sparkling Water 12 Pack', 'Sparkling Water 24 Pack']
  );
  const [trail] = rankProductCandidates(MASTER_DATA.Product, expandProductSearchTerms(['trail mix']));
  assert.deepEqual(trail.candidates.map((candidate) => candidate.ProductName), ['Trail Mix Pouch']);
});
