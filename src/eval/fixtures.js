// Evaluation fixtures for the multi-fixture (test-suite) oracle, after Zhong et
// al. 2020, "Semantic Evaluation for Text-to-SQL with Distilled Test Suites":
// a prediction counts as correct only if it returns the gold answer on EVERY
// fixture database. One tiny seed lets plausible-wrong SQL coincide with the
// gold (the audit measured 46% of 108 hand-written wrong queries caught on the
// seed alone); fixtures that separate the coinciding columns, dates and
// filters catch them.
//
// Every fixture shares MASTER_DATA (src/eval/fixture-data.js) and differs only
// in the fact tables, because the model's prompt context (master-data
// candidates, product names) is computed from the primary fixture.
//
// - seed (demo_retail): the original demo facts, also loaded by `npm run
//   seed-demo`. Primary fixture: the product loop runs here.
// - v2 (demo_retail_v2): the audit's hand-designed fixture
//   (.local/audit-2026-10-05/mutation/v2_fixture.sql + v2b_patch.sql), ported
//   to code. Each change targets one family of wrong SQL (see buildV2Facts).
// - v3 (demo_retail_v3): ~250 documents from a seeded PRNG (V3_PRNG_SEED) over
//   Jan - Mar 2025 and Nov 2025 - May 2026, so top-N LIMITs bind, ties occur,
//   and every cancel / date-column / grain / measure confusion has many rows
//   to show up on (see generateV3Facts).
//
// The content is generated from code (no fixture is read from another), so
// `npm run seed-fixtures` rebuilds all three from scratch. Each database's
// _fixture_meta table records the content hash it was seeded with; whether it
// still HOLDS that content is checked by re-hashing its rows
// (checkFixtureContent in fixture-seeder.js), which seed-fixtures,
// verify-dataset and the benchmark do.

import crypto from 'node:crypto';

import { FACT_TABLES, MASTER_DATA, MASTER_TABLES, PRIMARY_KEYS, SEED_FACTS, SEEDED_TABLES, TABLE_COLUMNS } from './fixture-data.js';
import { createPrng } from './prng.js';

// Bump when the generated content of any fixture changes on purpose; the
// fixture meta table records it next to the content hash.
export const FIXTURE_GENERATOR_VERSION = '2';
// Fixed seed for v3. Changing it changes v3's content (and its pins).
export const V3_PRNG_SEED = 20260331;

export const FIXTURE_META_TABLE = '_fixture_meta';

export const FIXTURES = Object.freeze([
  Object.freeze({ name: 'seed', database: 'demo_retail', description: 'Original demo seed: 9 documents, January-April 2026.' }),
  Object.freeze({ name: 'v2', database: 'demo_retail_v2', description: 'Hand-designed discriminating facts (audit mutation workstream v2 + v2b).' }),
  Object.freeze({ name: 'v3', database: 'demo_retail_v3', description: `Seeded-PRNG facts (seed ${V3_PRNG_SEED}), November 2025 - May 2026.` }),
]);

export const PRIMARY_FIXTURE = FIXTURES[0];

export function getFixture(name) {
  const fixture = FIXTURES.find((entry) => entry.name === name);
  if (!fixture) {
    throw new Error(`Unknown fixture "${name}". Known fixtures: ${FIXTURES.map((entry) => entry.name).join(', ')}.`);
  }
  return fixture;
}

/**
 * Fixtures selected by name (array or comma-separated string), in FIXTURES
 * order. Null/empty selects all of them.
 */
export function resolveFixtures(names = null) {
  const requested = (Array.isArray(names) ? names : String(names ?? '').split(','))
    .map((name) => String(name).trim())
    .filter(Boolean);
  if (requested.length === 0) {
    return [...FIXTURES];
  }
  for (const name of requested) {
    getFixture(name);
  }
  return FIXTURES.filter((fixture) => requested.includes(fixture.name));
}

const cloneRows = (rows) => rows.map((row) => ({ ...row }));

function cloneTables(tables) {
  return Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, cloneRows(rows)]));
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function round3(value) {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

function addDays(isoDate, days) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// --- v2: the audit's hand-designed fixture -----------------------------------

/**
 * v2 = the seed facts plus the audit's v2 and v2b changes and this PR's v2c
 * rows (addV2cFacts), each aimed at one family of plausible-wrong SQL:
 * - header metrics separated: NetPayable = Net + 12.50 and BillTotal = Gross +
 *   7.25 on every document (Net vs NetPayable, Gross vs BillTotal swaps);
 * - line TotalAmount = Net x 1.05 (line Net vs TotalAmount swaps);
 * - header-level discounts on documents 2 and 4, so header Net differs from the
 *   sum of line Net (header vs line grain);
 * - canceled documents in January, February and March, one with postings
 *   (dropped cancel filters, also on the accounting cases);
 * - documents on month-boundary days whose PostingDate falls in another month
 *   (DocumentDate vs PostingDate, off-by-one month boundaries);
 * - multi-line documents and a NULL-ProductId fee line (COUNT vs COUNT
 *   DISTINCT, LEFT JOIN, NOT IN over NULLs);
 * - a manual journal entry with NULL SalesDocumentId (accounting joins);
 * - 2025 documents in February and March (MONTH() without YEAR());
 * - sub-cent line amounts, a fractional quantity, a quantity tie, stale
 *   product/brand/category snapshots, a NULL CampaignId, and sales for the
 *   second "Summit Grocers" and the tag-only seltzer.
 */
export function buildV2Facts() {
  const facts = cloneTables(SEED_FACTS);
  const documents = new Map(facts.SalesDocument.map((row) => [row.SalesDocumentId, row]));
  const lines = new Map(facts.SalesDocumentLine.map((row) => [row.SalesDocumentLineId, row]));
  const postings = new Map(facts.AccountingPosting.map((row) => [row.AccountingPostingId, row]));

  // Seed lines: TotalAmount (pre-adjustment) != NetAmount; stale snapshots.
  for (const line of facts.SalesDocumentLine) {
    line.TotalAmount = round2(line.NetAmount * 1.05);
  }
  lines.get(3).BrandNameSnapshot = 'Northstar Beverages Co';
  lines.get(9).CategoryNameSnapshot = 'Baking';
  // v2b: the product was renamed after February; the old line keeps the old name.
  lines.get(5).ProductNameSnapshot = 'Basmati Rice 5kg';

  // Document 2 becomes multi-line with a header-level discount (header Net 845
  // vs line sum 860); document 4 gets one too (690 vs 700).
  facts.SalesDocumentLine.push({ SalesDocumentLineId: 11, SalesDocumentId: 2, ProductId: 10, ProductNameSnapshot: 'Spring Water 24 Pack', Quantity: 4, SalePrice: 15, TotalAmount: 63, NetAmount: 60, CategoryNameSnapshot: 'Beverages', BrandNameSnapshot: 'Clearspring Waters' });
  Object.assign(documents.get(2), { NetAmount: 845, GrossAmount: 946, SubtotalAmount: 890, PaidAmount: 845, BalanceAmount: 0 });
  postings.get(3).DebitAmount = 845;
  postings.get(4).CreditAmount = 845;
  documents.get(4).NetAmount = 690;
  postings.get(5).DebitAmount = 690;
  postings.get(6).CreditAmount = 690;

  // New documents (v2: 10-19). Document 10 is canceled in March WITH postings.
  // 13: dated 03-31, posted 04-01. 14: dated 02-28, posted 03-02. 15: dated
  // 04-01. 16: dated 03-01, a second invoice for C-001 with a NULL-ProductId fee
  // line. 17: dated 01-31, posted 02-02. 18: C-008 (the second "Summit
  // Grocers"), sub-cent lines, the seltzer under a stale name. 19: dated 02-27,
  // posted 03-03, no postings.
  const newDocuments = [
    [10, 'SD-2026-0010', '2026-03-20', '2026-03-20', '2026-04-20', 2, 1, 1, 2, 1, 924.0, 840.0, 0, 0, 0, 882.0, 0],
    [11, 'SD-2026-0011', '2026-02-15', '2026-02-15', '2026-03-17', 3, 3, 2, 1, 1, 220.0, 200.0, 0, 0, 0, 210.0, 0],
    [12, 'SD-2026-0012', '2026-01-20', '2026-01-20', '2026-02-19', 3, 3, 2, 1, 1, 165.0, 150.0, 0, 0, 0, 157.5, 0],
    [13, 'SD-2026-0013', '2026-03-31', '2026-04-01', '2026-04-30', 3, 3, 2, 3, 0, 269.51, 245.01, 0, 245.01, 0, 257.26, 0],
    [14, 'SD-2026-0014', '2026-02-28', '2026-03-02', '2026-03-30', 4, 2, 4, 1, 0, 363.0, 330.0, 0, 330.0, 0, 346.5, 0],
    [15, 'SD-2026-0015', '2026-04-01', '2026-04-01', '2026-05-01', 1, 1, 1, 2, 0, 253.0, 230.0, 0, 0, 0, 241.5, 0],
    [16, 'SD-2026-0016', '2026-03-01', '2026-03-01', '2026-03-31', 1, 1, 1, 2, 0, 357.5, 325.0, 0, 325.0, 0, 340.0, 0],
    [17, 'SD-2026-0017', '2026-01-31', '2026-02-02', '2026-03-02', 2, 1, 1, 1, 0, 110.0, 100.0, 0, 100.0, 0, 105.0, 0],
    [18, 'SD-2026-0018', '2026-03-25', '2026-03-25', '2026-04-24', 8, 2, 4, 2, 0, 245.23, 222.94, 0, 222.94, 0, 234.09, 0],
    [19, 'SD-2026-0019', '2026-02-27', '2026-03-03', '2026-03-29', 3, 3, 2, 2, 0, 176.0, 160.0, 0, 0, 0, 168.0, 0],
  ];
  for (const values of newDocuments) {
    facts.SalesDocument.push(Object.fromEntries(TABLE_COLUMNS.SalesDocument.map((column, index) => [column, values[index]])));
  }

  const newLines = [
    [12, 10, 3, 'Cold Brew Coffee 6 Pack', 5, 40, 210.0, 200.0, 'Beverages', 'Northstar Goods'],
    [13, 10, 11, 'Sparkling Water 24 Pack', 4, 110, 462.0, 440.0, 'Beverages', 'Northstar Goods'],
    [14, 10, 5, 'Long Grain Rice 5kg', 2, 100, 210.0, 200.0, 'Pantry', 'Riverbend Pantry'],
    [15, 11, 2, 'Protein Bar Box', 2, 100, 210.0, 200.0, 'Snacks', 'Sunvale Foods'],
    [16, 12, 6, 'Kitchen Towels 4 Roll', 3, 50, 157.5, 150.0, 'Household', 'Homebase Supply'],
    [17, 13, 4, 'Trail Mix Pouch', 3, 41.67, 131.26, 125.01, 'Snacks', 'Sunvale Foods'],
    [18, 13, 1, 'Sparkling Water 12 Pack', 2, 60, 126.0, 120.0, 'Beverages', 'Northstar Goods'],
    [19, 14, 8, 'Herbal Tea Variety Pack', 6, 30, 189.0, 180.0, 'Beverages', 'Northstar Goods'],
    [20, 14, 5, 'Long Grain Rice 5kg', 1.5, 100, 157.5, 150.0, 'Pantry', 'Riverbend Pantry'],
    [21, 15, 8, 'Herbal Tea Variety Pack', 4, 30, 126.0, 120.0, 'Beverages', 'Northstar Goods'],
    [22, 15, 11, 'Sparkling Water 24 Pack', 1, 110, 115.5, 110.0, 'Beverages', 'Northstar Goods'],
    [23, 16, 1, 'Sparkling Water 12 Pack', 5, 60, 315.0, 300.0, 'Beverages', 'Northstar Goods'],
    [24, 16, null, 'Delivery Fee', 1, 25, 25.0, 25.0, null, null],
    [25, 17, 6, 'Kitchen Towels 4 Roll', 2, 50, 105.0, 100.0, 'Household', 'Homebase Supply'],
    [26, 18, 9, 'Lime Fizz 8 Pack', 13, 9.995, 136.43, 129.935, 'Beverages', 'Northstar Goods'],
    [27, 18, 10, 'Spring Water 24 Pack', 3, 14.335, 45.16, 43.005, 'Beverages', 'Clearspring Waters'],
    [28, 18, 12, 'Northstar Trail Crisps', 4, 12.5, 52.5, 50.0, 'Snacks', 'Northstar Goods'],
    [29, 19, 3, 'Cold Brew Coffee 6 Pack', 4, 40, 168.0, 160.0, 'Beverages', 'Northstar Goods'],
  ];
  for (const values of newLines) {
    facts.SalesDocumentLine.push(Object.fromEntries(TABLE_COLUMNS.SalesDocumentLine.map((column, index) => [column, values[index]])));
  }

  // Postings: doc 10 (canceled) is posted in March; 13 and 15 post on 04-01;
  // 14 on 03-02; a manual journal (NULL SalesDocumentId) on 03-28 poisons
  // NOT IN (SELECT SalesDocumentId ...) and leaks into posting-date-only queries.
  const newPostings = [
    [11, 10, 2, '2026-03-20', 840.0, 0],
    [12, 10, 1, '2026-03-20', 0, 840.0],
    [13, 13, 2, '2026-04-01', 245.01, 0],
    [14, 13, 1, '2026-04-01', 0, 245.01],
    [15, 14, 2, '2026-03-02', 330.0, 0],
    [16, 14, 1, '2026-03-02', 0, 330.0],
    [17, 15, 2, '2026-04-01', 230.0, 0],
    [18, 15, 1, '2026-04-01', 0, 230.0],
    [19, 16, 2, '2026-03-01', 325.0, 0],
    [20, 16, 1, '2026-03-01', 0, 300.0],
    [21, 16, 4, '2026-03-01', 0, 25.0],
    [22, 18, 2, '2026-03-25', 222.94, 0],
    [23, 18, 1, '2026-03-25', 0, 222.94],
    [24, 18, 3, '2026-03-25', 90.0, 0],
    [25, 18, 4, '2026-03-25', 0, 90.0],
    [26, null, 3, '2026-03-28', 75.0, 0],
    [27, null, 4, '2026-03-28', 0, 75.0],
  ];
  for (const values of newPostings) {
    facts.AccountingPosting.push(Object.fromEntries(TABLE_COLUMNS.AccountingPosting.map((column, index) => [column, values[index]])));
  }

  // Header metric separation on every v2 document.
  for (const document of facts.SalesDocument) {
    document.NetPayableAmount = round2(document.NetAmount + 12.5);
    document.BillTotalAmount = round2(document.GrossAmount + 7.25);
    document.BalanceAmount = round2(document.NetPayableAmount - document.PaidAmount);
  }

  // v2b: 2025 documents in the same calendar months (20: 2025-03-14 with rice,
  // 22: 2025-02-10); 21: March 2026 with a NULL CampaignId and a fractional
  // quantity; 23: a February sale for the second "Summit Grocers" (C-008).
  const v2bDocuments = [
    [20, 'SD-2025-0020', '2025-03-14', '2025-03-14', '2025-04-13', 2, 1, 1, 1, 0, 220.0, 200.0, 212.5, 200.0, 12.5, 210.0, 227.25],
    [21, 'SD-2026-0021', '2026-03-12', '2026-03-12', '2026-04-11', 4, 2, 4, null, 0, 137.5, 125.0, 137.5, 125.0, 12.5, 131.25, 144.75],
    [22, 'SD-2025-0022', '2025-02-10', '2025-02-10', '2025-03-12', 1, 1, 1, 1, 0, 440.0, 400.0, 412.5, 400.0, 12.5, 420.0, 447.25],
    [23, 'SD-2026-0023', '2026-02-12', '2026-02-12', '2026-03-14', 8, 2, 4, 1, 0, 27.5, 25.0, 37.5, 25.0, 12.5, 26.25, 34.75],
  ];
  for (const values of v2bDocuments) {
    facts.SalesDocument.push(Object.fromEntries(TABLE_COLUMNS.SalesDocument.map((column, index) => [column, values[index]])));
  }
  const v2bLines = [
    [30, 20, 5, 'Long Grain Rice 5kg', 2, 100, 210.0, 200.0, 'Pantry', 'Riverbend Pantry'],
    [31, 21, 7, 'Cane Sugar 2kg', 2.5, 50, 131.25, 125.0, 'Pantry', 'Riverbend Pantry'],
    [32, 22, 2, 'Protein Bar Box', 4, 100, 420.0, 400.0, 'Snacks', 'Sunvale Foods'],
    [33, 23, 12, 'Northstar Trail Crisps', 2, 12.5, 26.25, 25.0, 'Snacks', 'Northstar Goods'],
  ];
  for (const values of v2bLines) {
    facts.SalesDocumentLine.push(Object.fromEntries(TABLE_COLUMNS.SalesDocumentLine.map((column, index) => [column, values[index]])));
  }

  addV2cFacts(facts);
  return facts;
}

/**
 * v2c (this PR's review): rows aimed at plausible-wrong SQL that v2 + v2b let
 * through (each listed with the family it separates):
 * - 24: 2025-03-20, posted, Urban Refresh products incl. the Sparkling Water
 *   24 Pack, which no non-canceled March 2026 document sells (MONTH() = 3
 *   without YEAR() on the ledger, campaign and sparkling-water cases);
 * - 25, 26, 27: twins of documents 21 (March), 17 (January) and 19
 *   (February): same customer, month, header amounts and line NetAmount, and
 *   for 21/25 equal AR debits and revenue credits (SUM(DISTINCT ...) over
 *   header, line and posting amounts). Document 25 sells its Cane Sugar as
 *   2 x 62.50, so the product's March quantity stays fractional (23.5);
 * - 28, 29, 30: the inactive customer 6 buys in January, February and March
 *   2026, in March the discontinued Oat Cookies Tin (an invented IsActive
 *   filter on Customer or Product) and 5 Sparkling Water 12 Packs, the same
 *   quantity and line Net as document 16's line (SUM(DISTINCT Quantity));
 * - 31: a canceled February document for a product with no non-canceled
 *   February or March sale (a cancel filter applied to only one side of a
 *   "February but not March" set difference);
 * - 30 also carries a NULL-ProductId delivery fee in February (a set
 *   difference that keeps NULL product IDs), and 32 sells 300.00 of Cane
 *   Sugar in March, so the March category totals are not in category-ID
 *   order (a ranking without ORDER BY that GROUP BY happens to sort) while
 *   at most nine products sell in March (a LEFT JOIN's NULL product group
 *   stays inside a top-10);
 * - 33: Harbor Kiosk (active, never orders in seed and v3) orders in April
 *   2026, so with customer 6 buying, the number of customers with sales (8)
 *   differs from the number of active customers (7) here too ("active" read
 *   as "has sales").
 * Every document keeps v2's separated header metrics (NetPayable = Net +
 * 12.50, BillTotal = Gross + 7.25) and line TotalAmount = Net x 1.05.
 */
function addV2cFacts(facts) {
  const document = ([id, date, postingDate, customerId, storeId, typeId, campaignId, canceled, net, gross, paid, subtotal]) => {
    const netPayable = round2(net + 12.5);
    return Object.fromEntries(
      TABLE_COLUMNS.SalesDocument.map((column, index) => [
        column,
        [
          id,
          `SD-${date.slice(0, 4)}-${String(id).padStart(4, '0')}`,
          date,
          postingDate,
          addDays(date, 30),
          customerId,
          storeId,
          typeId,
          campaignId,
          canceled,
          gross,
          net,
          netPayable,
          paid,
          round2(netPayable - paid),
          subtotal,
          round2(gross + 7.25),
        ][index],
      ])
    );
  };
  const v2cDocuments = [
    [24, '2025-03-20', '2025-03-20', 1, 1, 1, 2, 0, 340.0, 374.0, 340.0, 357.0],
    [25, '2026-03-26', '2026-03-26', 4, 2, 4, null, 0, 125.0, 137.5, 125.0, 131.25],
    [26, '2026-01-08', '2026-01-08', 2, 1, 1, 1, 0, 100.0, 110.0, 100.0, 105.0],
    [27, '2026-02-05', '2026-02-05', 3, 3, 2, 2, 0, 160.0, 176.0, 0, 168.0],
    [28, '2026-03-09', '2026-03-09', 6, 2, 4, 2, 0, 390.0, 429.0, 390.0, 409.5],
    [29, '2026-01-15', '2026-01-15', 6, 1, 1, 1, 0, 135.0, 148.5, 135.0, 141.75],
    [30, '2026-02-18', '2026-02-18', 6, 2, 4, 3, 0, 75.0, 82.5, 0, 77.5],
    [31, '2026-02-10', '2026-02-10', 5, 1, 1, 2, 1, 110.0, 121.0, 0, 115.5],
    [32, '2026-03-17', '2026-03-18', 1, 2, 4, 1, 0, 300.0, 330.0, 300.0, 315.0],
    [33, '2026-04-10', '2026-04-10', 7, 2, 4, 1, 0, 30.0, 33.0, 30.0, 31.5],
  ];
  facts.SalesDocument.push(...v2cDocuments.map(document));

  const v2cLines = [
    [34, 24, 11, 'Sparkling Water 24 Pack', 2, 110, 231.0, 220.0, 'Beverages', 'Northstar Goods'],
    [35, 24, 3, 'Cold Brew Coffee 6 Pack', 3, 40, 126.0, 120.0, 'Beverages', 'Northstar Goods'],
    [36, 25, 7, 'Cane Sugar 2kg', 2, 62.5, 131.25, 125.0, 'Pantry', 'Riverbend Pantry'],
    [37, 26, 6, 'Kitchen Towels 4 Roll', 2, 50, 105.0, 100.0, 'Household', 'Homebase Supply'],
    [38, 27, 3, 'Cold Brew Coffee 6 Pack', 4, 40, 168.0, 160.0, 'Beverages', 'Northstar Goods'],
    [39, 28, 13, 'Oat Cookies Tin', 6, 15, 94.5, 90.0, 'Snacks', 'Sunvale Foods'],
    [40, 29, 8, 'Herbal Tea Variety Pack', 5, 27, 141.75, 135.0, 'Beverages', 'Northstar Goods'],
    [41, 30, 12, 'Northstar Trail Crisps', 4, 12.5, 52.5, 50.0, 'Snacks', 'Northstar Goods'],
    [42, 31, 11, 'Sparkling Water 24 Pack', 1, 110, 115.5, 110.0, 'Beverages', 'Northstar Goods'],
    [43, 28, 1, 'Sparkling Water 12 Pack', 5, 60, 315.0, 300.0, 'Beverages', 'Northstar Goods'],
    [44, 30, null, 'Delivery Fee', 1, 25, 25.0, 25.0, null, null],
    [45, 32, 7, 'Cane Sugar 2kg', 6, 50, 315.0, 300.0, 'Pantry', 'Riverbend Pantry'],
    [46, 33, 10, 'Spring Water 24 Pack', 2, 15, 31.5, 30.0, 'Beverages', 'Clearspring Waters'],
  ];
  for (const values of v2cLines) {
    facts.SalesDocumentLine.push(Object.fromEntries(TABLE_COLUMNS.SalesDocumentLine.map((column, index) => [column, values[index]])));
  }

  const v2cPostings = [
    [28, 24, 2, '2025-03-20', 340.0, 0],
    [29, 24, 1, '2025-03-20', 0, 340.0],
    [30, 21, 2, '2026-03-12', 125.0, 0],
    [31, 21, 1, '2026-03-12', 0, 125.0],
    [32, 25, 2, '2026-03-26', 125.0, 0],
    [33, 25, 1, '2026-03-26', 0, 125.0],
    [34, 28, 2, '2026-03-09', 390.0, 0],
    [35, 28, 1, '2026-03-09', 0, 390.0],
    [36, 32, 2, '2026-03-18', 300.0, 0],
    [37, 32, 1, '2026-03-18', 0, 300.0],
  ];
  for (const values of v2cPostings) {
    facts.AccountingPosting.push(Object.fromEntries(TABLE_COLUMNS.AccountingPosting.map((column, index) => [column, values[index]])));
  }
}

// --- v3: seeded random facts ---------------------------------------------------

// Months covered and documents per month. March 2026 (the month most cases ask
// about) is the busiest. January-March 2025 repeat the calendar months the
// cases ask about, so MONTH() without YEAR() picks up prior-year rows.
const V3_MONTHS = [
  [2025, 1, 16],
  [2025, 2, 16],
  [2025, 3, 18],
  [2025, 11, 22],
  [2025, 12, 24],
  [2026, 1, 26],
  [2026, 2, 28],
  [2026, 3, 44],
  [2026, 4, 30],
  [2026, 5, 24],
];

// Base unit prices and sales weights. kg products sometimes sell fractional
// quantities.
const V3_PRODUCTS = {
  1: { price: 60, weight: 10 },
  2: { price: 90, weight: 9 },
  3: { price: 40, weight: 9 },
  4: { price: 41.67, weight: 8 },
  5: { price: 100, weight: 6, fractional: true },
  6: { price: 50, weight: 7 },
  7: { price: 50, weight: 5, fractional: true },
  8: { price: 30, weight: 8 },
  9: { price: 9.95, weight: 6 },
  10: { price: 15, weight: 5 },
  11: { price: 110, weight: 4 },
  12: { price: 12.5, weight: 5 },
  13: { price: 15, weight: 4 },
};

// Cane Sugar (7) sells in February 2026 but, in March 2026, only on a canceled
// document: "products sold in February but not March" is then non-empty, and
// dropping the cancel filter changes it. Every other product sells in March,
// the discontinued Oat Cookies Tin (13) included.
const V3_FEB_ONLY_PRODUCT = 7;

// Harbor Kiosk (7) never trades. The inactive customer (6) trades too, and
// has a non-canceled document in each of January-March 2026 (forced), so an
// invented "active customers only" filter changes the customer cases.
const V3_INACTIVE_CUSTOMER = 6;
const V3_CUSTOMER_WEIGHTS = [
  [1, 10],
  [2, 9],
  [3, 8],
  [4, 7],
  [5, 6],
  [8, 4],
  [V3_INACTIVE_CUSTOMER, 3],
];

const STALE_CATEGORY_NAMES = { Beverages: 'Drinks', Snacks: 'Snack Foods', Pantry: 'Baking', Household: 'Home Care' };
const STALE_BRAND_NAMES = {
  'Northstar Goods': 'Northstar Beverages Co',
  'Sunvale Foods': 'Sunvale',
  'Riverbend Pantry': 'Riverbend Foods',
  'Homebase Supply': 'Homebase',
  'Clearspring Waters': 'Clearspring',
};

function productInfo(productId) {
  const product = MASTER_DATA.Product.find((row) => row.ProductId === productId);
  const category = MASTER_DATA.ProductCategory.find((row) => row.ProductCategoryId === product.ProductCategoryId);
  const brand = MASTER_DATA.Brand.find((row) => row.BrandId === product.BrandId);
  return { product, categoryName: category.CategoryName, brandName: brand.BrandName };
}

function isMarch2026(date) {
  return date >= '2026-03-01' && date < '2026-04-01';
}

/**
 * v3: about 250 documents (V3_MONTHS) drawn from createPrng(seed). Properties
 * the oracle relies on, each enforced by construction:
 * - January-March 2025 as well as November 2025 - May 2026 (prior-year rows
 *   in the calendar months the cases ask about);
 * - two documents on the first and two on the last day of every month, with
 *   last-day documents usually posted in the next month;
 * - ~7% canceled documents, some with postings, plus a canceled March document
 *   that carries the February-only product;
 * - 1-4 lines per document, discounts so line TotalAmount (before
 *   adjustments) != NetAmount, fractional kg quantities, a NULL-ProductId
 *   delivery-fee line on some documents, exactly two half-cent March lines in
 *   different products/categories/brands/campaigns (so per-row and
 *   per-aggregate rounding differ by at most 0.01 in any group);
 * - header discounts (header Net != sum of line Net), NetPayable = Net + fee,
 *   Gross = Net x tax, BillTotal = Gross + shipping, Subtotal = sum of line
 *   TotalAmount, so every header metric differs;
 * - stale product/category/brand snapshots, NULL CampaignIds, documents
 *   without postings and manual journals with NULL SalesDocumentId;
 * - in March 2026, 12 of the 13 products sell (so a top-10 LIMIT binds) with a
 *   clear gap between ranks 10 and 11 by quantity and by net amount (so the
 *   cut-off is unambiguous whatever the tie-break), and two customers tie on
 *   March net sales (ranked comparison must tolerate tie order);
 * - the inactive customer 6 buys in January-March 2026 and the discontinued
 *   product 13 sells in March 2026 (invented IsActive filters);
 * - a same-amount twin document in each of January-March 2026 (addV3Twins:
 *   SUM(DISTINCT ...) loses a value in that document's groups).
 */
export function generateV3Facts({ seed = V3_PRNG_SEED } = {}) {
  const random = createPrng(seed);
  const documents = [];
  const lines = [];

  // Products that must appear at least once (non-canceled) in a month.
  const mustSellInMarch = Object.keys(V3_PRODUCTS)
    .map(Number)
    .filter((productId) => productId !== V3_FEB_ONLY_PRODUCT);
  const mustSellInFebruary = [V3_FEB_ONLY_PRODUCT];
  let febOnlyCanceledInMarch = false;

  for (const [year, month, count] of V3_MONTHS) {
    const lastDay = lastDayOfMonth(year, month);
    const days = [1, 1, lastDay, lastDay];
    while (days.length < count) {
      days.push(random.int(1, lastDay));
    }
    days.sort((left, right) => left - right);

    for (const [dayIndex, day] of days.entries()) {
      const documentDate = isoDate(year, month, day);
      const inactiveCustomerBuys = year === 2026 && month <= 3 && dayIndex === 4;
      let delay = random.weighted([
        [0, 50],
        [1, 25],
        [2, 12],
        [3, 8],
        [5, 5],
      ]);
      if (day === lastDay && delay === 0 && random.chance(0.6)) {
        delay = random.int(1, 3);
      }
      const canceled =
        !inactiveCustomerBuys && (random.chance(0.07) || (isMarch2026(documentDate) && !febOnlyCanceledInMarch && day >= 10));
      const customerId = random.weighted(V3_CUSTOMER_WEIGHTS);
      const document = {
        SalesDocumentId: documents.length + 1,
        DocumentNo: `SD-${year}-${String(documents.length + 1).padStart(4, '0')}`,
        DocumentDate: documentDate,
        PostingDate: addDays(documentDate, delay),
        DueDate: addDays(documentDate, 30),
        CustomerId: inactiveCustomerBuys ? V3_INACTIVE_CUSTOMER : customerId,
        StoreLocationId: random.int(1, 3),
        DocumentTypeId: random.weighted([
          [1, 40],
          [2, 25],
          [4, 25],
          [3, 10],
        ]),
        CampaignId: random.weighted([
          [1, 30],
          [2, 30],
          [3, 30],
          [null, 10],
        ]),
        IsCanceled: canceled ? 1 : 0,
      };
      documents.push(document);

      // Products on this document (no repeats).
      const lineCount = random.weighted([
        [1, 30],
        [2, 35],
        [3, 22],
        [4, 13],
      ]);
      const chosen = [];
      if (canceled && isMarch2026(documentDate) && !febOnlyCanceledInMarch) {
        chosen.push(V3_FEB_ONLY_PRODUCT);
        febOnlyCanceledInMarch = true;
      } else if (!canceled && isMarch2026(documentDate) && mustSellInMarch.length > 0) {
        chosen.push(mustSellInMarch.shift());
      } else if (!canceled && year === 2026 && month === 2 && mustSellInFebruary.length > 0) {
        chosen.push(mustSellInFebruary.shift());
      }
      while (chosen.length < lineCount) {
        const productId = Number(
          random.weighted(Object.entries(V3_PRODUCTS).map(([id, info]) => [Number(id), info.weight]))
        );
        if (chosen.includes(productId)) {
          continue;
        }
        if (productId === V3_FEB_ONLY_PRODUCT && isMarch2026(documentDate) && !canceled) {
          continue;
        }
        chosen.push(productId);
      }

      for (const productId of chosen) {
        const { product, categoryName, brandName } = productInfo(productId);
        const config = V3_PRODUCTS[productId];
        const bulk = random.chance(0.05);
        let quantity = bulk ? random.int(15, 30) : random.int(1, 12);
        if (config.fractional && random.chance(0.3)) {
          quantity = random.int(1, 7) + 0.5;
        }
        const salePrice = round2(config.price * (1 + random.int(-5, 5) / 100));
        const discount = random.weighted([
          [0, 15],
          [0.02, 25],
          [0.05, 35],
          [0.1, 25],
        ]);
        const totalAmount = round2(quantity * salePrice);
        let productNameSnapshot = product.ProductName;
        if (productId === 5 && documentDate < '2026-02-15') {
          productNameSnapshot = 'Basmati Rice 5kg';
        } else if (productId === 9 && random.chance(0.5)) {
          productNameSnapshot = 'Lime Fizz 8 Pack';
        }
        lines.push({
          SalesDocumentLineId: lines.length + 1,
          SalesDocumentId: document.SalesDocumentId,
          ProductId: productId,
          ProductNameSnapshot: productNameSnapshot,
          Quantity: quantity,
          SalePrice: salePrice,
          TotalAmount: totalAmount,
          NetAmount: round2(totalAmount * (1 - discount)),
          CategoryNameSnapshot: random.chance(0.06) ? STALE_CATEGORY_NAMES[categoryName] : categoryName,
          BrandNameSnapshot: random.chance(0.06) ? STALE_BRAND_NAMES[brandName] : brandName,
        });
      }

      // A delivery fee (NULL ProductId) on some documents, always on the
      // inactive customer's January-March 2026 ones.
      if (inactiveCustomerBuys || random.chance(0.06)) {
        lines.push({
          SalesDocumentLineId: lines.length + 1,
          SalesDocumentId: document.SalesDocumentId,
          ProductId: null,
          ProductNameSnapshot: 'Delivery Fee',
          Quantity: 1,
          SalePrice: 25,
          TotalAmount: 25,
          NetAmount: 25,
          CategoryNameSnapshot: null,
          BrandNameSnapshot: null,
        });
      }
    }
  }

  const documentById = new Map(documents.map((document) => [document.SalesDocumentId, document]));
  const countsInMarch = (line) => {
    const document = documentById.get(line.SalesDocumentId);
    return document.IsCanceled === 0 && isMarch2026(document.DocumentDate) && line.ProductId !== null;
  };

  // Exactly two half-cent March lines, in different products, categories,
  // brands and campaigns (Trail Mix Pouch and Kitchen Towels).
  for (const productId of [4, 6]) {
    const line = lines.find((entry) => entry.ProductId === productId && countsInMarch(entry));
    line.NetAmount = round3(line.NetAmount + 0.005);
  }

  // Unambiguous top-10 cut-off in March: ranks 10 and 11 differ by at least 1
  // in quantity and in net amount (adds whole units to the 10th product).
  const marchTotals = (key) => {
    const totals = new Map();
    for (const line of lines.filter(countsInMarch)) {
      totals.set(line.ProductId, round3((totals.get(line.ProductId) || 0) + line[key]));
    }
    return [...totals.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0]);
  };
  for (let guard = 0; guard < 200; guard += 1) {
    const byQuantity = marchTotals('Quantity');
    const byNet = marchTotals('NetAmount');
    const quantityGap = byQuantity.length > 10 ? byQuantity[9][1] - byQuantity[10][1] : Infinity;
    const netGap = byNet.length > 10 ? byNet[9][1] - byNet[10][1] : Infinity;
    if (quantityGap >= 1 && netGap >= 1) {
      break;
    }
    const productId = quantityGap < 1 ? byQuantity[9][0] : byNet[9][0];
    const line = lines.find((entry) => entry.ProductId === productId && countsInMarch(entry));
    const discount = line.TotalAmount > 0 ? 1 - line.NetAmount / line.TotalAmount : 0;
    line.Quantity += 1;
    line.TotalAmount = round2(line.Quantity * line.SalePrice);
    line.NetAmount = round2(line.TotalAmount * (1 - discount));
  }

  // Headers from lines.
  const linesByDocument = new Map();
  for (const line of lines) {
    if (!linesByDocument.has(line.SalesDocumentId)) {
      linesByDocument.set(line.SalesDocumentId, []);
    }
    linesByDocument.get(line.SalesDocumentId).push(line);
  }
  for (const document of documents) {
    const documentLines = linesByDocument.get(document.SalesDocumentId) || [];
    const lineNet = round2(documentLines.reduce((sum, line) => sum + line.NetAmount, 0));
    const headerDiscount = random.chance(0.12) ? round2(lineNet * random.pick([0.02, 0.03, 0.05])) : 0;
    document.NetAmount = round2(lineNet - headerDiscount);
    document.SubtotalAmount = round2(documentLines.reduce((sum, line) => sum + line.TotalAmount, 0));
    document.taxRate = random.pick([1.06, 1.1, 1.12]);
    document.fee = random.weighted([
      [0, 30],
      [4.95, 35],
      [12.5, 35],
    ]);
    document.shipping = random.weighted([
      [0, 35],
      [7.25, 40],
      [9.9, 25],
    ]);
    document.paidShare = random.weighted([
      [1, 60],
      [0, 20],
      [0.5, 20],
    ]);
  }

  // A tie: the second- and third-ranked customers by March net sales end up
  // with the same total (the third's last March document absorbs the gap).
  const marchNetByCustomer = new Map();
  for (const document of documents) {
    if (document.IsCanceled === 0 && isMarch2026(document.DocumentDate)) {
      marchNetByCustomer.set(document.CustomerId, round2((marchNetByCustomer.get(document.CustomerId) || 0) + document.NetAmount));
    }
  }
  const ranked = [...marchNetByCustomer.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0]);
  const [, second, third] = ranked;
  const gap = round2(second[1] - third[1]);
  const lastThirdDocument = documents.filter(
    (document) => document.CustomerId === third[0] && document.IsCanceled === 0 && isMarch2026(document.DocumentDate)
  ).at(-1);
  lastThirdDocument.NetAmount = round2(lastThirdDocument.NetAmount + gap);

  for (const document of documents) {
    document.GrossAmount = round2(document.NetAmount * document.taxRate);
    document.NetPayableAmount = round2(document.NetAmount + document.fee);
    document.BillTotalAmount = round2(document.GrossAmount + document.shipping);
    document.PaidAmount = document.IsCanceled ? 0 : round2(document.NetPayableAmount * document.paidShare);
    document.BalanceAmount = round2(document.NetPayableAmount - document.PaidAmount);
    delete document.taxRate;
    delete document.fee;
    delete document.shipping;
    delete document.paidShare;
  }

  // Postings: AR debit / revenue credit at the document's posting date; some
  // split the credit with sales tax, some add a COGS pair; some documents are
  // never posted; some canceled ones were posted before the cancellation.
  const postings = [];
  const post = (salesDocumentId, ledgerAccountId, postingDate, debit, credit) => {
    postings.push({
      AccountingPostingId: postings.length + 1,
      SalesDocumentId: salesDocumentId,
      LedgerAccountId: ledgerAccountId,
      PostingDate: postingDate,
      DebitAmount: debit,
      CreditAmount: credit,
    });
  };
  for (const document of documents) {
    if (!random.chance(document.IsCanceled ? 0.35 : 0.82)) {
      continue;
    }
    const net = document.NetAmount;
    post(document.SalesDocumentId, 2, document.PostingDate, net, 0);
    if (random.chance(0.25)) {
      const tax = round2(net * 0.05);
      post(document.SalesDocumentId, 1, document.PostingDate, 0, round2(net - tax));
      post(document.SalesDocumentId, 4, document.PostingDate, 0, tax);
    } else {
      post(document.SalesDocumentId, 1, document.PostingDate, 0, net);
    }
    if (random.chance(0.2)) {
      const cost = round2(net * 0.4);
      post(document.SalesDocumentId, 3, document.PostingDate, cost, 0);
      post(document.SalesDocumentId, 4, document.PostingDate, 0, cost);
    }
  }
  for (const [postingDate, amount] of [
    ['2025-12-31', 64.2],
    ['2026-03-15', 120.5],
    ['2026-03-31', 58.75],
  ]) {
    post(null, 3, postingDate, amount, 0);
    post(null, 4, postingDate, 0, amount);
  }

  addV3Twins({ documents, lines, postings, tiedCustomers: [second[0], third[0]] });
  return { SalesDocument: documents, SalesDocumentLine: lines, AccountingPosting: postings };
}

// Top-10 cut-off in March 2026 (ranks 10 and 11 differ by at least 1 in
// quantity and in net amount), recomputed over the final rows.
function marchTopTenGapHolds(documents, lines) {
  const byId = new Map(documents.map((document) => [document.SalesDocumentId, document]));
  const counted = lines.filter((line) => {
    const document = byId.get(line.SalesDocumentId);
    return line.ProductId !== null && document.IsCanceled === 0 && isMarch2026(document.DocumentDate);
  });
  return ['Quantity', 'NetAmount'].every((key) => {
    const totals = new Map();
    for (const line of counted) {
      totals.set(line.ProductId, round3((totals.get(line.ProductId) || 0) + line[key]));
    }
    const sorted = [...totals.values()].sort((left, right) => right - left);
    return sorted.length <= 10 || sorted[9] - sorted[10] >= 1;
  });
}

const isHalfCent = (amount) => Math.round(amount * 1000) % 10 !== 0;

/**
 * Same-amount twins: in each of January, February and March 2026 one
 * document gets a twin (same customer, dates, header amounts, lines and
 * postings; new IDs). SUM(DISTINCT ...) over header Net/Gross, line Net or
 * Quantity, or posting Debit/Credit then drops a value in that customer's,
 * product's, brand's, category's and account's group. The source is the
 * first non-canceled, posted document of the month whose customer is not in
 * the March tie and whose lines are whole-cent product lines, and whose twin
 * keeps the March top-10 cut-off unambiguous.
 */
function addV3Twins({ documents, lines, postings, tiedCustomers }) {
  for (const month of ['2026-01', '2026-02', '2026-03']) {
    const candidates = documents.filter(
      (document) =>
        document.IsCanceled === 0 &&
        document.DocumentDate.startsWith(month) &&
        !tiedCustomers.includes(document.CustomerId) &&
        postings.some((posting) => posting.SalesDocumentId === document.SalesDocumentId) &&
        lines.some((line) => line.SalesDocumentId === document.SalesDocumentId) &&
        lines.every((line) => line.SalesDocumentId !== document.SalesDocumentId || (line.ProductId !== null && !isHalfCent(line.NetAmount)))
    );
    let added = false;
    for (const source of candidates) {
      const twinId = documents.length + 1;
      const twin = { ...source, SalesDocumentId: twinId, DocumentNo: `SD-2026-${String(twinId).padStart(4, '0')}` };
      const twinLines = lines
        .filter((line) => line.SalesDocumentId === source.SalesDocumentId)
        .map((line, index) => ({ ...line, SalesDocumentLineId: lines.length + index + 1, SalesDocumentId: twinId }));
      if (!marchTopTenGapHolds([...documents, twin], [...lines, ...twinLines])) {
        continue;
      }
      documents.push(twin);
      lines.push(...twinLines);
      const sourcePostings = postings.filter((posting) => posting.SalesDocumentId === source.SalesDocumentId);
      for (const posting of sourcePostings) {
        postings.push({ ...posting, AccountingPostingId: postings.length + 1, SalesDocumentId: twinId });
      }
      added = true;
      break;
    }
    if (!added) {
      throw new Error(`v3 generator: no document in ${month} can take a same-amount twin.`);
    }
  }
}

// --- assembly, hashing ---------------------------------------------------------

const FACT_BUILDERS = {
  seed: () => cloneTables(SEED_FACTS),
  v2: () => buildV2Facts(),
  v3: () => generateV3Facts(),
};

/** All rows of one fixture: shared master data plus that fixture's facts. */
export function buildFixtureRows(name) {
  getFixture(name);
  const facts = FACT_BUILDERS[name]();
  const rows = { ...cloneTables(MASTER_DATA) };
  for (const table of FACT_TABLES) {
    rows[table] = [...facts[table]].sort((left, right) => left[PRIMARY_KEYS[table]] - right[PRIMARY_KEYS[table]]);
  }
  return rows;
}

// Canonical cell text for hashing: what the database will hold, independent
// of JS number formatting (DECIMAL(24,8) columns read back as numbers, DATE as
// Dates, so both sides normalize to the same text).
function canonicalCell(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    const pad = (part) => String(part).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(8)));
  }
  return String(value);
}

/**
 * sha256 over every seeded table (or only `tableNames`), row and column in a
 * canonical order. `tables` may be generated rows or rows read back from the
 * database.
 */
export function fixtureContentHash(tables, { tableNames = SEEDED_TABLES } = {}) {
  const hash = crypto.createHash('sha256');
  for (const table of tableNames) {
    const columns = TABLE_COLUMNS[table];
    const key = PRIMARY_KEYS[table];
    const rows = [...(tables[table] || [])].sort((left, right) => Number(left[key]) - Number(right[key]));
    hash.update(JSON.stringify([table, columns, rows.map((row) => columns.map((column) => canonicalCell(row[column])))]));
    hash.update('\n');
  }
  return hash.digest('hex');
}

/** sha256 over the master (dimension) tables only: what every fixture shares. */
export function masterDataHash(tables) {
  return fixtureContentHash(tables, { tableNames: MASTER_TABLES });
}

/** The master-data hash every fixture database must have (MASTER_DATA). */
export const SHARED_MASTER_DATA_HASH = masterDataHash(MASTER_DATA);

export function fixtureRowCounts(tables) {
  return Object.fromEntries(SEEDED_TABLES.map((table) => [table, (tables[table] || []).length]));
}

/** What `seed-fixtures` writes to a fixture's meta table. */
export function describeFixtureContent(name, rows = buildFixtureRows(name)) {
  return {
    name,
    database: getFixture(name).database,
    generatorVersion: FIXTURE_GENERATOR_VERSION,
    prngSeed: name === 'v3' ? V3_PRNG_SEED : null,
    contentHash: fixtureContentHash(rows),
    rowCounts: fixtureRowCounts(rows),
  };
}
