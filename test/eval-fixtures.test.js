import assert from 'node:assert/strict';
import test from 'node:test';

import { FACT_TABLES, MASTER_DATA, MASTER_TABLES, SEED_FACTS } from '../src/eval/fixture-data.js';
import { checkFixtureContent, seedFixture } from '../src/eval/fixture-seeder.js';
import {
  FIXTURE_GENERATOR_VERSION,
  FIXTURE_META_TABLE,
  FIXTURES,
  PRIMARY_FIXTURE,
  SHARED_MASTER_DATA_HASH,
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
  seed: '094282546fe55afd',
  v2: '9eb81d9084a0f015',
  v3: '74d0d295b559986f',
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

  assert.equal(facts.SalesDocument.length, 49);
  assert.equal(facts.SalesDocumentLine.length, 69);
  assert.equal(facts.AccountingPosting.length, 63);
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

test('v2c adds prior-year postings, same-amount twins, inactive customer/product sales and a canceled February sale', () => {
  const facts = buildV2Facts();
  const documents = new Map(facts.SalesDocument.map((row) => [row.SalesDocumentId, row]));
  const live = (document) => document.IsCanceled === 0;
  const inMonth = (document, month) => document.DocumentDate.startsWith(month);
  const linesOf = (id) => facts.SalesDocumentLine.filter((line) => line.SalesDocumentId === id);
  const productOf = (id) => MASTER_DATA.Product.find((row) => row.ProductId === id);

  // Prior-year March: posted, Urban Refresh products, a sparkling SKU no
  // non-canceled March 2026 document sells.
  const priorMarch = facts.SalesDocument.filter((document) => live(document) && inMonth(document, '2025-03'));
  assert.ok(priorMarch.some((document) => facts.AccountingPosting.some((posting) => posting.SalesDocumentId === document.SalesDocumentId)));
  const priorLines = priorMarch.flatMap((document) => linesOf(document.SalesDocumentId));
  assert.ok(priorLines.some((line) => productOf(line.ProductId)?.CampaignId === 2), 'an Urban Refresh product');
  const march2026Products = new Set(
    facts.SalesDocument.filter((document) => live(document) && inMonth(document, '2026-03')).flatMap((document) => linesOf(document.SalesDocumentId).map((line) => line.ProductId))
  );
  assert.ok(priorLines.some((line) => /seltzer/.test(productOf(line.ProductId)?.ProductTags || '') && !march2026Products.has(line.ProductId)));

  // Same customer, month and amounts in January, February and March 2026.
  for (const month of ['2026-01', '2026-02', '2026-03']) {
    const seen = new Set();
    const twin = facts.SalesDocument.filter((document) => live(document) && inMonth(document, month)).some((document) => {
      const key = `${document.CustomerId}/${document.NetAmount}/${document.GrossAmount}`;
      const found = seen.has(key);
      seen.add(key);
      return found;
    });
    assert.ok(twin, `${month} has a same-amount twin`);
  }
  assert.equal(linesOf(25)[0].NetAmount, linesOf(21)[0].NetAmount);
  const marchDebits = facts.AccountingPosting.filter((posting) => posting.LedgerAccountId === 2 && posting.SalesDocumentId && inMonth(documents.get(posting.SalesDocumentId), '2026-03'));
  assert.ok(new Set(marchDebits.map((posting) => posting.DebitAmount)).size < marchDebits.length, 'equal AR debits in March');

  // The inactive customer and the discontinued product sell in 2026.
  for (const month of ['2026-01', '2026-02', '2026-03']) {
    assert.ok(facts.SalesDocument.some((document) => live(document) && inMonth(document, month) && document.CustomerId === 6), `customer 6 buys in ${month}`);
  }
  assert.equal(productOf(13).IsActive, 0);
  assert.ok(march2026Products.has(13), 'the discontinued product sells in March 2026');
  assert.equal(march2026Products.has(null) ? march2026Products.size - 1 : march2026Products.size, 9, 'at most nine products sell in March');

  // A canceled February sale of a product without a non-canceled Feb/Mar sale.
  assert.equal(documents.get(31).IsCanceled, 1);
  assert.equal(linesOf(31)[0].ProductId, 11);
  assert.ok(!march2026Products.has(11));
  assert.ok(linesOf(30).some((line) => line.ProductId === null), 'a February delivery fee');

  // Customers with sales (8) != active customers (7), also in v2.
  const buyers = new Set(facts.SalesDocument.filter(live).map((document) => document.CustomerId));
  assert.equal(buyers.size, 8);
  assert.equal(MASTER_DATA.Customer.filter((customer) => customer.IsActive === 1).length, 7);
});

test('v2d separates the families the templated controls found surviving', () => {
  const facts = buildV2Facts();
  const documents = new Map(facts.SalesDocument.map((row) => [row.SalesDocumentId, row]));
  const live = (document) => document.IsCanceled === 0;
  const inMonth = (document, month) => document.DocumentDate.startsWith(month);
  const linesOf = (id) => facts.SalesDocumentLine.filter((line) => line.SalesDocumentId === id);
  const v2d = facts.SalesDocument.filter((document) => document.SalesDocumentId >= 34);
  assert.equal(v2d.length, 16);

  // Every non-canceled v2d document is posted (the all-time "documents without
  // postings" count is unchanged); the canceled ones are not.
  for (const document of v2d) {
    const posted = facts.AccountingPosting.some((posting) => posting.SalesDocumentId === document.SalesDocumentId);
    assert.equal(posted, live(document), `document ${document.SalesDocumentId}`);
  }

  // Harbor Kiosk: a canceled first-day Q1 document, its only 2025 document
  // dated 2025-12-31 and posted in 2026, and a document the day after Q1.
  const harbor = facts.SalesDocument.filter((document) => document.CustomerId === 7);
  assert.deepEqual(
    harbor.filter((document) => document.DocumentDate < '2026-04-02').map((document) => [document.DocumentDate, document.PostingDate, document.IsCanceled]),
    [['2026-01-01', '2026-01-01', 1], ['2025-12-31', '2026-01-02', 0], ['2026-04-01', '2026-04-01', 0]]
  );

  // Both customers named Summit Grocers buy in February 2026; merged by name
  // they overtake the third-ranked customer.
  const februaryNet = new Map();
  for (const document of facts.SalesDocument.filter((entry) => live(entry) && inMonth(entry, '2026-02'))) {
    februaryNet.set(document.CustomerId, (februaryNet.get(document.CustomerId) || 0) + document.NetAmount);
  }
  const ranked = [...februaryNet.values()].sort((left, right) => right - left);
  assert.ok(februaryNet.get(5) < ranked[2] && februaryNet.get(5) + februaryNet.get(8) > ranked[2]);
  assert.deepEqual(facts.SalesDocument.filter((entry) => live(entry) && inMonth(entry, '2026-02') && entry.CustomerId === 5).map((entry) => entry.DocumentDate), ['2026-02-01']);

  // The largest non-canceled March document is on the first day; a larger one
  // dated in February is posted in March; a larger canceled one exists.
  const march = facts.SalesDocument.filter((entry) => inMonth(entry, '2026-03'));
  const largestLive = march.filter(live).sort((left, right) => right.NetAmount - left.NetAmount)[0];
  assert.deepEqual([largestLive.DocumentDate, largestLive.NetAmount], ['2026-03-01', 1800]);
  assert.ok(documents.get(40).NetAmount > largestLive.NetAmount && documents.get(40).PostingDate.startsWith('2026-03') && inMonth(documents.get(40), '2026-02'));
  assert.ok(march.some((entry) => !live(entry) && entry.NetAmount > largestLive.NetAmount && entry.PaidAmount > 0));

  // Canceled documents in April 2026 and December 2025; December 2025 sales.
  assert.ok(facts.SalesDocument.some((entry) => !live(entry) && inMonth(entry, '2026-04')));
  assert.ok(facts.SalesDocument.some((entry) => !live(entry) && inMonth(entry, '2025-12')));
  assert.equal(facts.SalesDocument.filter((entry) => live(entry) && inMonth(entry, '2025-12')).length, 5);

  // Manual journals on 2026-01-01 and in April 2026.
  const journals = facts.AccountingPosting.filter((posting) => posting.SalesDocumentId === null).map((posting) => posting.PostingDate);
  assert.ok(journals.includes('2026-01-01') && journals.some((date) => date.startsWith('2026-04')));

  // March 2026 category totals stay out of category-ID order.
  const marchLines = march.filter(live).flatMap((entry) => linesOf(entry.SalesDocumentId)).filter((line) => line.ProductId !== null);
  const categoryTotals = new Map();
  for (const line of marchLines) {
    const categoryId = MASTER_DATA.Product.find((row) => row.ProductId === line.ProductId).ProductCategoryId;
    categoryTotals.set(categoryId, (categoryTotals.get(categoryId) || 0) + line.NetAmount);
  }
  const byTotal = [...categoryTotals.entries()].sort((left, right) => right[1] - left[1]).map(([id]) => id);
  assert.notDeepEqual(byTotal, [...byTotal].sort((left, right) => left - right));
});

test('v3 is a large seeded fact set with the traps the oracle needs', () => {
  const facts = generateV3Facts();
  const documents = facts.SalesDocument;
  const byId = new Map(documents.map((document) => [document.SalesDocumentId, document]));
  const lines = facts.SalesDocumentLine;

  assert.ok(documents.length >= 150 && documents.length <= 300, `${documents.length} documents`);
  assert.ok(lines.length >= 2 * documents.length, 'multiple lines per document on average');
  const months = new Set(documents.map((document) => document.DocumentDate.slice(0, 7)));
  assert.deepEqual([...months].sort(), ['2025-01', '2025-02', '2025-03', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05']);

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
  // Harbor Kiosk orders once (addV3dFacts): its only document is dated on the
  // first day of February 2026 and posted in March.
  const harbor = documents.filter((document) => document.CustomerId === 7);
  assert.deepEqual(harbor.map((document) => [document.DocumentDate, document.PostingDate, document.IsCanceled]), [['2026-02-01', '2026-03-02', 0]]);

  // Header metrics all differ somewhere; line Total != Net on most lines.
  const lineNet = (id) => lines.filter((line) => line.SalesDocumentId === id).reduce((sum, line) => sum + line.NetAmount, 0);
  assert.ok(documents.some((document) => Math.abs(document.NetAmount - lineNet(document.SalesDocumentId)) > 0.01));
  assert.ok(documents.filter((document) => document.NetPayableAmount !== document.NetAmount).length > documents.length / 2);
  assert.ok(lines.filter((line) => line.TotalAmount !== line.NetAmount).length > lines.length / 2);

  // March 2026: 12 products sell (a top-10 LIMIT binds) with a clear 10/11 gap.
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
    assert.equal(sorted.length, 12);
    assert.ok(sorted[9] - sorted[10] >= 1, `${key} cut-off gap`);
  }
  assert.ok(!counted.some((line) => line.ProductId === 7), 'Cane Sugar sells in March only on a canceled document');
  assert.ok(counted.some((line) => line.ProductId === 13), 'the discontinued product sells in March');

  // The inactive customer buys in January-March 2026, with a delivery fee.
  for (const month of ['2026-01', '2026-02', '2026-03']) {
    const own = documents.filter((document) => document.CustomerId === 6 && document.IsCanceled === 0 && document.DocumentDate.startsWith(month));
    assert.ok(own.length > 0, `customer 6 buys in ${month}`);
    assert.ok(own.some((document) => lines.some((line) => line.SalesDocumentId === document.SalesDocumentId && line.ProductId === null)), `${month} fee line`);
  }

  // Same-amount twins in every month: header, lines and postings.
  for (const month of [...months].sort()) {
    const twin = documents.find((document, index) =>
      document.DocumentDate.startsWith(month) &&
      document.IsCanceled === 0 &&
      documents.some((other, otherIndex) => otherIndex < index && other.CustomerId === document.CustomerId && other.DocumentDate === document.DocumentDate && other.NetAmount === document.NetAmount && other.GrossAmount === document.GrossAmount)
    );
    assert.ok(twin, `${month} twin`);
    const original = documents.find((document) => document !== twin && document.CustomerId === twin.CustomerId && document.DocumentDate === twin.DocumentDate && document.NetAmount === twin.NetAmount);
    const amounts = (id, table, key) => facts[table].filter((row) => row.SalesDocumentId === id).map((row) => row[key]);
    assert.deepEqual(amounts(twin.SalesDocumentId, 'SalesDocumentLine', 'NetAmount'), amounts(original.SalesDocumentId, 'SalesDocumentLine', 'NetAmount'));
    assert.deepEqual(amounts(twin.SalesDocumentId, 'AccountingPosting', 'DebitAmount'), amounts(original.SalesDocumentId, 'AccountingPosting', 'DebitAmount'));
    assert.ok(amounts(twin.SalesDocumentId, 'AccountingPosting', 'DebitAmount').length > 0);
  }

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

// --- deep content checks (fake connection: no database needed) -------------

// A fake admin/query connection over in-memory tables: answers the meta-row
// SELECT and the per-table SELECTs readFixtureTables issues, records writes.
function fakeFixtureDatabase({ tables, meta }) {
  const statements = [];
  return {
    statements,
    async query(sql) {
      statements.push(sql);
      if (sql.includes(FIXTURE_META_TABLE) && sql.startsWith('SELECT')) {
        if (!meta) {
          throw Object.assign(new Error('no meta table'), { code: 'ER_NO_SUCH_TABLE' });
        }
        return [[meta]];
      }
      const read = /^SELECT .* FROM `[^`]+`\.`([^`]+)` ORDER BY/.exec(sql);
      if (read) {
        if (!tables) {
          throw Object.assign(new Error('no such table'), { code: 'ER_NO_SUCH_TABLE' });
        }
        return [tables[read[1]].map((row) => ({ ...row }))];
      }
      return [[]];
    },
  };
}

const metaRowFor = (name, contentHash = describeFixtureContent(name).contentHash) => ({
  name,
  content_hash: contentHash,
  generator_version: FIXTURE_GENERATOR_VERSION,
  prng_seed: null,
  row_counts: '{}',
  created_at: new Date(),
});

test('checkFixtureContent re-hashes the rows: current, drifted, stale, missing, and master-data drift', async () => {
  const v2 = FIXTURES[1];
  const rows = buildFixtureRows('v2');

  const current = await checkFixtureContent(fakeFixtureDatabase({ tables: rows, meta: metaRowFor('v2') }), v2);
  assert.equal(current.status, 'current');
  assert.equal(current.masterDataMatches, true);
  assert.equal(current.masterDataHash, SHARED_MASTER_DATA_HASH);

  // A fact row edited after seeding: the meta row still claims the content.
  const editedFacts = { ...rows, SalesDocument: rows.SalesDocument.map((row) => (row.SalesDocumentId === 1 ? { ...row, NetAmount: row.NetAmount + 1 } : row)) };
  const drifted = await checkFixtureContent(fakeFixtureDatabase({ tables: editedFacts, meta: metaRowFor('v2') }), v2);
  assert.equal(drifted.status, 'drifted');
  assert.equal(drifted.masterDataMatches, true);

  // A master row deleted: the identical-master-data invariant is broken.
  const editedMaster = { ...rows, Customer: rows.Customer.filter((row) => row.CustomerId !== 7) };
  const brokenMaster = await checkFixtureContent(fakeFixtureDatabase({ tables: editedMaster, meta: metaRowFor('v2') }), v2);
  assert.equal(brokenMaster.status, 'drifted');
  assert.equal(brokenMaster.masterDataMatches, false);

  assert.equal((await checkFixtureContent(fakeFixtureDatabase({ tables: editedFacts, meta: metaRowFor('v2', 'old') }), v2)).status, 'stale');
  assert.equal((await checkFixtureContent(fakeFixtureDatabase({ tables: editedFacts, meta: null }), v2)).status, 'missing');
  // Correct rows without a meta row (e.g. written by an older seed script) are current.
  assert.equal((await checkFixtureContent(fakeFixtureDatabase({ tables: rows, meta: null }), v2)).status, 'current');
  const empty = await checkFixtureContent(fakeFixtureDatabase({ tables: null, meta: null }), v2);
  assert.equal(empty.status, 'missing');
  assert.equal(empty.masterDataMatches, false);
});

test('seedFixture skips a database only when its rows hash to the generated content', async () => {
  const schema = { tables: [] };
  const seed = FIXTURES[0];
  const rows = buildFixtureRows('seed');
  const writes = (connection) => connection.statements.filter((sql) => /^(DELETE|INSERT)/.test(sql));

  const untouched = fakeFixtureDatabase({ tables: rows, meta: metaRowFor('seed') });
  assert.equal((await seedFixture(untouched, seed, { schema })).action, 'unchanged');
  assert.deepEqual(writes(untouched), []);

  // Same meta row and the same row counts, but a value edited after seeding.
  const edited = { ...rows, Product: rows.Product.map((row) => (row.ProductId === 3 ? { ...row, IsActive: 0 } : row)) };
  const tampered = fakeFixtureDatabase({ tables: edited, meta: metaRowFor('seed') });
  assert.equal((await seedFixture(tampered, seed, { schema })).action, 'seeded');
  assert.ok(writes(tampered).some((sql) => sql.startsWith('INSERT INTO `Product`')), 'the rows are rewritten');
});
