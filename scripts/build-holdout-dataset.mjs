// Fresh holdout (v2): datasets/holdout-public.json and its oracle controls
// datasets/controls/holdout-public.json.
//
//   npm run build-holdout-dataset            # rewrite both files
//   npm run build-holdout-dataset -- --check # exit 1 when the committed files differ
//
// Provenance: authored blind on 2026-10-06 and frozen. The author saw the
// schema (models/), the master data (src/eval/fixture-data.js), the dataset
// format and the existing datasets (to avoid their intents), and the semantic
// layer and the few-shot pool only to keep their vocabulary and examples out.
// No model output, failure analysis, run report or baseline was looked at
// while writing it, and nothing in the product (prompt rules, few-shot pool,
// semantic layer) was tuned on it. Do not edit the questions or golds to
// chase a score: a change gives the case a new id (below), and the set stops
// being a fresh holdout once anyone tunes against it. Add a new holdout
// instead.
//
// Every case is split 'holdout' by construction (not by the intent hash of
// splitForIntent: the whole set is held out). Questions follow the holdout
// wording rule of the other datasets: no multi-word phrase of
// metadata/semantic-layer.json and not the enforced word "revenue" (the build
// fails on either). Unlike the templated generator, intents are hand-written:
// each lists its gold SQL (and any alternative reading), the comparison block
// and 1-3 phrasings, some of them Swedish, bilingual, typo-ridden or
// shorthand. Gold SQL follows the repo conventions: IFNULL(d.IsCanceled, 0) =
// 0, half-open date ranges, COALESCE inside aggregates, ROUND(.., 2) for money
// and ROUND(.., 3) for units, line amounts for product-level questions, and a
// tiebreak after the metric before any LIMIT.
//
// Ids are `ho2_<intentId>_<first 6 hex of sha256(question)>`: editing a
// question yields a new id, so an id is never reused for another question.
//
// Pins: expected_row_counts are carried over from the committed dataset for
// every case whose id and gold SQL are unchanged; `npm run verify-dataset --
// --dataset holdout-public --write-pins` (re)writes them on freshly seeded
// fixtures, and a second build keeps them.
//
// Controls: per intent, negative controls built from the gold with one knob
// changed. The generator's mutation families (cancel filter dropped,
// PostingDate for DocumentDate, both off-by-one window sides, MONTH() without
// YEAR(), another amount column, a header amount repeated per line, SUM
// DISTINCT, the duplicate customer name merged, a dropped filter or GROUP BY
// key, the wrong join path or a stale snapshot, wrong order or LIMIT) are the
// design controls, gated at a 0.95 kill rate by verify-dataset. Held-out
// controls (`h*`, `heldout: true`) are the families the fixtures were never
// designed against (QUARTER() without YEAR(), snapshot filters and grouping,
// and the mistakes specific to these new shapes: a ratio's denominator, the
// LAG window, an ageing bucket edge, ...): reported, not gated. A design
// family that cannot change an intent's answer, or that no fixture separates
// (the fixtures are frozen for this set), is not emitted and is recorded under
// `not_emitted` with the reason. Positive controls are correct rewrites (a
// BETWEEN for a half-open window over a DATE column, a CTE, another alias).

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { serialize } from './build-eval-dataset.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATASET_NAME = 'holdout-public';
export const DATASET_PATH = path.join(ROOT, 'datasets', `${DATASET_NAME}.json`);
export const CONTROLS_PATH = path.join(ROOT, 'datasets', 'controls', `${DATASET_NAME}.json`);
export const SEMANTIC_LAYER_PATH = path.join(ROOT, 'metadata', 'semantic-layer.json');
export const AUTHORED_ON = '2026-10-06';
export const ID_PREFIX = 'ho2_';

// --- holdout wording rule ---------------------------------------------------

/**
 * Every multi-word synonym of the semantic layer (entities, metrics, filter
 * hints, value aliases and their canonical values, clarification triggers),
 * lower-cased. Holdout questions must contain none of them. (These lived in
 * build-eval-dataset.mjs until its holdout was retired; the wording rule now
 * belongs to the blind holdout alone.)
 */
export function semanticLayerPhrases(layer) {
  const phrases = new Set();
  const add = (value) => {
    const text = String(value || '').toLowerCase().trim();
    if (text.split(/\s+/).length > 1) {
      phrases.add(text);
    }
  };
  for (const entity of layer.entities || []) {
    (entity.synonyms || []).forEach(add);
  }
  for (const metric of layer.metrics || []) {
    (metric.synonyms || []).forEach(add);
    (metric.advisory_synonyms || []).forEach(add);
    (metric.count_advisory_synonyms || []).forEach(add);
  }
  for (const hint of layer.filter_hints || []) {
    (hint.synonyms || []).forEach(add);
  }
  for (const alias of layer.value_aliases || []) {
    add(alias.canonical_value);
    (alias.aliases || []).forEach(add);
  }
  for (const rule of layer.clarification_rules || []) {
    add(rule.trigger);
  }
  return [...phrases].sort();
}

/** Lower-case words joined by single spaces, punctuation dropped (Unicode letters kept). */
export function normalizeWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The semantic-layer phrases that occur in `question` as whole words, a plural
 * ending included ("credit memos" contains "credit memo").
 */
export function semanticLayerPhrasesIn(question, phrases) {
  const words = ` ${normalizeWords(question)} `;
  return phrases.filter((phrase) => {
    const needle = normalizeWords(phrase);
    return [' ', 's ', 'es '].some((ending) => words.includes(` ${needle}${ending}`));
  });
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

export function holdoutCaseIdFor(intentId, question) {
  return `${ID_PREFIX}${intentId}_${sha256Hex(question).slice(0, 6)}`;
}

/** Same rule as controls.goldFingerprint (whitespace-normalized sha256, 16 hex). */
function goldFingerprint(sql) {
  return sha256Hex(String(sql || '').replace(/\s+/g, ' ').trim()).slice(0, 16);
}

// --- SQL fragments -------------------------------------------------------------------

/** Collapses a multi-line SQL template into one line. */
const s = (text) => text.replace(/\s+/g, ' ').trim();

const NC = 'IFNULL(d.IsCanceled, 0) = 0';
const LINES = 'SalesDocumentLine l JOIN SalesDocument d ON l.SalesDocumentId = d.SalesDocumentId';
const PJ = 'JOIN Product p ON l.ProductId = p.ProductId';
const CJ = 'JOIN Customer c ON d.CustomerId = c.CustomerId';
const SJ = 'JOIN StoreLocation s ON d.StoreLocationId = s.StoreLocationId';
const TJ = 'JOIN DocumentType t ON d.DocumentTypeId = t.DocumentTypeId';
const AJ = 'JOIN LedgerAccount a ON p.LedgerAccountId = a.LedgerAccountId';
const PCJ = 'JOIN ProductCategory pc ON p.ProductCategoryId = pc.ProductCategoryId';
const BJ = 'JOIN Brand b ON p.BrandId = b.BrandId';
const CPJ = 'JOIN Campaign cp ON p.CampaignId = cp.CampaignId';
const NET = 'SUM(COALESCE(d.NetAmount, 0))';
const LNET = 'SUM(COALESCE(l.NetAmount, 0))';
const QTY = 'SUM(COALESCE(l.Quantity, 0))';

const win = (start, end, column = 'd.DocumentDate') => `${column} >= '${start}' AND ${column} < '${end}'`;
const Q1_2026 = win('2026-01-01', '2026-04-01');
const Y2026 = win('2026-01-01', '2027-01-01');
const Y2025 = win('2025-01-01', '2026-01-01');
const FEB_2026 = win('2026-02-01', '2026-03-01');
const MAR_2026 = win('2026-03-01', '2026-04-01');
const APR_2026 = win('2026-04-01', '2026-05-01');

// Month labels of a series: the gold uses 'YYYY-MM'; alternatives accept the
// other common forms (as the templated series do).
const MONTH_LABELS = {
  ym: (column) => `DATE_FORMAT(${column}, '%Y-%m')`,
  ymd: (column) => `DATE_FORMAT(${column}, '%Y-%m-01')`,
  num: (column) => `MONTH(${column})`,
  name: (column) => `MONTHNAME(${column})`,
  abbrYear: (column) => `DATE_FORMAT(${column}, '%b %Y')`,
  nameYear: (column) => `DATE_FORMAT(${column}, '%M %Y')`,
};
const ONE_YEAR_LABELS = ['ymd', 'num', 'name', 'abbrYear', 'nameYear'];
const SERIES_NOTE =
  "A month can be labelled several ways; alternative_expected_sql accepts the same series labelled 'YYYY-MM-01', with the month number, with the month name, as 'Jan 2026' or as 'January 2026' (the gold uses 'YYYY-MM').";

// Posting-date ledger questions accept both readings of canceled documents'
// postings (the convention of the templated ledger cases): every posting in
// the window (the gold), or without the postings of canceled sales documents
// (LEFT JOIN, which keeps manual journals).
const LEDGER_CANCEL_ALT_JOIN = 'LEFT JOIN SalesDocument d ON p.SalesDocumentId = d.SalesDocumentId';
const LEDGER_NOTE =
  'Ledger postings selected by AccountingPosting.PostingDate. Two readings are accepted: every posting in the window, manual journals included (the gold), and the same without the postings of canceled sales documents (alternative_expected_sql: LEFT JOIN SalesDocument with the cancel filter, which keeps manual journals).';
function ledgerCancelAlternative(sql) {
  return replaceAll(sql, ` ${AJ} WHERE `, ` ${AJ} ${LEDGER_CANCEL_ALT_JOIN} WHERE ${NC} AND `);
}

// --- mutation helpers ---------------------------------------------------------------

function replaceAll(sql, from, to) {
  if (!sql.includes(from)) {
    throw new Error(`pattern not found: "${from}" in ${sql}`);
  }
  return sql.split(from).join(to);
}

function replaceFirst(sql, from, to) {
  const index = sql.indexOf(from);
  if (index === -1) {
    throw new Error(`pattern not found: "${from}" in ${sql}`);
  }
  return `${sql.slice(0, index)}${to}${sql.slice(index + from.length)}`;
}

function applyPairs(sql, pairs) {
  return pairs.reduce((out, [from, to]) => replaceAll(out, from, to), sql);
}

function dropCancel(sql) {
  const out = sql.split(`WHERE ${NC} AND `).join('WHERE ').split(` AND ${NC}`).join('').split(` WHERE ${NC}`).join('');
  if (out === sql) {
    throw new Error(`no cancel filter in ${sql}`);
  }
  return out;
}

function addDays(isoDate, days) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

// A design family that no fixture separates for an intent is not emitted; the
// reason names the fixture rows that would be needed (the fixtures are frozen
// for this holdout, so no row is added for it).
const fixtureLimit = (type, note, detail) => ({
  type,
  note,
  reason: `fixture limit (fixtures frozen for this holdout): it returns the gold answer on all three fixtures; ${detail}`,
});
const equivalentHere = (type, note, detail) => ({ type, note, reason: `equivalent here: ${detail}` });
const NO_2027 = 'no fixture has data after May 2026, so nothing is dated 2027-01-01';

const BOUNDARY_NOTES = {
  start: 'first day of the window excluded (> instead of >=)',
  end: 'day after the window included (<= instead of <)',
};

// Knobs: [name, ...args]. Design families first; the same knob may be listed
// under `heldout` for a held-out mutant.
const KNOBS = {
  cancel: () => ({ type: 'cancel', note: 'canceled documents not excluded', apply: dropCancel }),
  date_col: () => ({
    type: 'date_col',
    note: 'PostingDate instead of DocumentDate',
    apply: (sql) => replaceAll(sql, 'd.DocumentDate', 'd.PostingDate'),
  }),
  start: (column = 'd.DocumentDate') => ({
    type: 'date_boundary',
    note: BOUNDARY_NOTES.start,
    apply: (sql) => replaceAll(sql, `${column} >= '`, `${column} > '`),
  }),
  end: (column = 'd.DocumentDate') => ({
    type: 'date_boundary',
    note: BOUNDARY_NOTES.end,
    apply: (sql) => replaceAll(sql, `${column} < '`, `${column} <= '`),
  }),
  month_only: (month, column = 'd.DocumentDate') => {
    const start = `${month}-01`;
    const [year, number] = month.split('-').map(Number);
    const end = number === 12 ? `${year + 1}-01-01` : `${year}-${String(number + 1).padStart(2, '0')}-01`;
    return {
      type: 'date_filter',
      note: 'MONTH() without YEAR(): the same month of every year is included',
      apply: (sql) => replaceAll(sql, win(start, end, column), `MONTH(${column}) = ${number}`),
    };
  },
  quarter_only: (start, end, quarter, column = 'd.DocumentDate') => ({
    type: 'date_filter',
    note: 'QUARTER() without YEAR(): the same quarter of every year is included',
    apply: (sql) => replaceAll(sql, win(start, end, column), `QUARTER(${column}) = ${quarter}`),
  }),
  metric: (from, to, note) => ({ type: 'metric', note, apply: (sql) => replaceAll(sql, from, to) }),
  sum_distinct: () => ({
    type: 'sum_distinct',
    note: 'SUM(DISTINCT ...) drops repeated values',
    apply: (sql) => replaceAll(sql, 'SUM(COALESCE(', 'SUM(DISTINCT COALESCE('),
  }),
  group_by_name: (from = 'GROUP BY c.CustomerId, c.CustomerName', to = 'GROUP BY c.CustomerName') => ({
    type: 'group_by',
    note: 'grouped by CustomerName only: the two customers named Summit Grocers are merged',
    apply: (sql) => replaceAll(sql, from, to),
  }),
  fan_out: (note = 'the header amount repeated for every line (joined to SalesDocumentLine)') => ({
    type: 'grain',
    note,
    apply: (sql) => replaceFirst(sql, 'FROM SalesDocument d ', 'FROM SalesDocument d JOIN SalesDocumentLine l ON l.SalesDocumentId = d.SalesDocumentId '),
  }),
  rep: (type, note, pairs) => ({ type, note, apply: (sql) => applyPairs(sql, pairs) }),
  sql: (type, note, text) => ({ type, note, apply: () => s(text) }),
};

// Positive knobs: correct rewrites of the gold.
const POSITIVE_KNOBS = {
  between: (start, end, column = 'd.DocumentDate') => ({
    note: `the half-open window written as BETWEEN '${start}' AND '${addDays(end, -1)}' (${column} is a DATE)`,
    apply: (sql) => replaceAll(sql, win(start, end, column), `${column} BETWEEN '${start}' AND '${addDays(end, -1)}'`),
  }),
  rep: (note, pairs) => ({ note, apply: (sql) => applyPairs(sql, pairs) }),
  sql: (note, text) => ({ note, apply: () => s(text) }),
};

function buildKnob(table, spec) {
  const [name, ...args] = spec;
  if (!table[name]) {
    throw new Error(`unknown knob ${name}`);
  }
  return table[name](...args);
}

// Phrasing helpers: a string, or { q, tags, failure_class, knownRejection }.
const sv = (q) => ({ q, tags: ['swedish'], failure_class: 'multilingual' });
const bi = (q) => ({ q, tags: ['bilingual'], failure_class: 'multilingual' });
const typo = (q) => ({ q, tags: ['typo'], failure_class: 'typo' });

// --- intents -------------------------------------------------------------------------
//
// Fields: intentId, category (the main reason the intent is in the set),
// difficulty, failure_class, tags, phrasings, sql (or series: label => sql),
// alternatives, comparison, notes, negative / heldout (knobs), not_emitted
// ({ type, note, reason }), positive (positive knobs). `answer: false` marks
// an abstain case (no gold).

const INTENTS = [
  // ---- customer segment, shares and ratios ----
  {
    intentId: 'segment_turnover_q1_2026',
    category: 'new_dimension',
    difficulty: 'medium',
    failure_class: 'vocabulary',
    tags: ['net_sales', 'customer_segment', 'quarter'],
    phrasings: ['Break down Q1 2026 turnover by customer segment.', sv('Omsättning per kundsegment under första kvartalet 2026?'), typo('turnover by cust segmnt q1 26')],
    sql: `SELECT c.CustomerSegment, ROUND(${NET}, 2) AS total_net_amount FROM SalesDocument d ${CJ} WHERE ${NC} AND ${Q1_2026} GROUP BY c.CustomerSegment ORDER BY ${NET} DESC, c.CustomerSegment ASC`,
    comparison: { mode: 'rowset', decimals: 2 },
    negative: [['cancel'], ['date_col'], ['start'], ['end'], ['metric', 'd.NetAmount', 'd.GrossAmount', 'gross instead of net'], ['sum_distinct'], ['fan_out']],
    heldout: [['quarter_only', '2026-01-01', '2026-04-01', 1]],
    positive: [['between', '2026-01-01', '2026-04-01']],
  },
  {
    intentId: 'wholesale_share_mar_2026',
    category: 'ratio',
    difficulty: 'hard',
    failure_class: 'ratio_metric',
    tags: ['net_sales', 'customer_segment', 'share', 'single_month'],
    phrasings: ['What percentage of March 2026 net takings came from wholesale customers?', "Wholesale customers' share of March 2026 turnover, in percent?"],
    sql: `SELECT ROUND(100 * SUM(CASE WHEN c.CustomerSegment = 'Wholesale' THEN COALESCE(d.NetAmount, 0) ELSE 0 END) / ${NET}, 2) AS wholesale_share_pct FROM SalesDocument d ${CJ} WHERE ${NC} AND ${MAR_2026}`,
    comparison: { mode: 'scalar', decimals: 2, tolerance: 0.01 },
    notes: 'Net amount of documents of Wholesale-segment customers as a percentage of all net amount in the month.',
    negative: [['cancel'], ['date_col'], ['start'], ['end'], ['month_only', '2026-03'], ['metric', 'd.NetAmount', 'd.GrossAmount', 'gross instead of net'], ['fan_out']],
    heldout: [['rep', 'ratio', 'a fraction instead of a percentage', [['ROUND(100 * ', 'ROUND(']]]],
  },
  {
    intentId: 'store_share_q1_2026',
    category: 'ratio',
    difficulty: 'hard',
    failure_class: 'ratio_metric',
    tags: ['net_sales', 'store_location', 'share', 'quarter'],
    phrasings: ['What share of Q1 2026 turnover did each store contribute, in percent?', bi('Andel av turnover per butik i Q1 2026, in percent.')],
    sql: `SELECT s.LocationName, ROUND(100 * ${NET} / SUM(${NET}) OVER (), 2) AS share_pct FROM SalesDocument d ${SJ} WHERE ${NC} AND ${Q1_2026} GROUP BY s.StoreLocationId, s.LocationName ORDER BY share_pct DESC, s.LocationName ASC`,
    comparison: { mode: 'rowset', decimals: 2, tolerance: 0.01 },
    negative: [['cancel'], ['date_col'], ['start'], ['end'], ['metric', 'd.NetAmount', 'd.GrossAmount', 'gross instead of net'], ['fan_out']],
    heldout: [
      ['quarter_only', '2026-01-01', '2026-04-01', 1],
      ['rep', 'ratio', 'share of documents instead of share of turnover', [[`100 * ${NET} / SUM(${NET}) OVER ()`, '100 * COUNT(*) / SUM(COUNT(*)) OVER ()']]],
      [
        'sql',
        'ratio',
        'denominator over all time instead of the quarter',
        `SELECT s.LocationName, ROUND(100 * ${NET} / (SELECT SUM(COALESCE(d2.NetAmount, 0)) FROM SalesDocument d2 WHERE IFNULL(d2.IsCanceled, 0) = 0), 2) AS share_pct FROM SalesDocument d ${SJ} WHERE ${NC} AND ${Q1_2026} GROUP BY s.StoreLocationId, s.LocationName ORDER BY share_pct DESC, s.LocationName ASC`,
      ],
    ],
    positive: [
      [
        'sql',
        'the totals in a CTE, the share computed against their sum',
        `WITH totals AS (SELECT s.StoreLocationId, s.LocationName, ${NET} AS net FROM SalesDocument d ${SJ} WHERE ${NC} AND ${Q1_2026} GROUP BY s.StoreLocationId, s.LocationName) SELECT totals.LocationName, ROUND(100 * totals.net / (SELECT SUM(net) FROM totals), 2) AS pct FROM totals ORDER BY pct DESC`,
      ],
    ],
  },
  {
    intentId: 'category_unit_mix_feb_2026',
    category: 'ratio',
    difficulty: 'hard',
    failure_class: 'ratio_metric',
    tags: ['quantity', 'product_category', 'share', 'single_month'],
    phrasings: ['For February 2026, what percentage of total unit volume came from each category?', 'Category mix by units for Feb 2026, as percentages.'],
    sql: `SELECT pc.CategoryName, ROUND(100 * ${QTY} / SUM(${QTY}) OVER (), 2) AS unit_share_pct FROM ${LINES} ${PJ} ${PCJ} WHERE ${NC} AND ${FEB_2026} GROUP BY pc.ProductCategoryId, pc.CategoryName ORDER BY unit_share_pct DESC, pc.CategoryName ASC`,
    comparison: { mode: 'rowset', decimals: 2, tolerance: 0.01 },
    notes: 'Units are product units (the join to Product leaves out the NULL-ProductId delivery-fee lines); the category comes from Product.ProductCategoryId.',
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['end'],
      ['month_only', '2026-02'],
      ['rep', 'stale_snapshot', 'grouped by the stale l.CategoryNameSnapshot instead of the category master data', [[`${PCJ} `, ''], ['pc.CategoryName', 'l.CategoryNameSnapshot'], ['pc.ProductCategoryId, ', '']]],
      ['rep', 'join_path', "category through the brand's default category instead of Product.ProductCategoryId", [[PCJ, `${BJ} JOIN ProductCategory pc ON b.ProductCategoryId = pc.ProductCategoryId`]]],
      ['metric', 'l.Quantity', 'l.NetAmount', 'share of line net amount instead of units'],
    ],
  },
  {
    intentId: 'void_rate_by_store_q1_2026',
    category: 'new_vocabulary',
    difficulty: 'hard',
    failure_class: 'ratio_metric',
    tags: ['canceled', 'store_location', 'share', 'quarter'],
    phrasings: [
      'What proportion of the documents raised at each store in Q1 2026 were voided? Give it as a percentage.',
      typo('wich store had the highest % of voided docs in Q1 2026? show every store'),
    ],
    sql: `SELECT s.LocationName, ROUND(100 * SUM(CASE WHEN IFNULL(d.IsCanceled, 0) = 1 THEN 1 ELSE 0 END) / COUNT(*), 2) AS voided_pct FROM SalesDocument d ${SJ} WHERE ${Q1_2026} GROUP BY s.StoreLocationId, s.LocationName ORDER BY voided_pct DESC, s.LocationName ASC`,
    comparison: { mode: 'rowset', decimals: 2, tolerance: 0.01 },
    notes: 'Voided = canceled (IsCanceled = 1). Every document dated in the quarter counts in the denominator, canceled or not.',
    negative: [
      ['date_col'],
      ['start'],
      ['end'],
      ['fan_out', 'every line counted as a document (joined to SalesDocumentLine)'],
      ['rep', 'cancel', 'the usual cancel filter applied, so no voided document is left to count', [[`WHERE ${Q1_2026}`, `WHERE ${NC} AND ${Q1_2026}`]]],
    ],
    heldout: [
      ['quarter_only', '2026-01-01', '2026-04-01', 1],
      ['rep', 'ratio', 'voided documents divided by the documents that were not voided', [['/ COUNT(*)', '/ SUM(CASE WHEN IFNULL(d.IsCanceled, 0) = 0 THEN 1 ELSE 0 END)']]],
    ],
  },
  {
    intentId: 'collection_rate_mar_2026',
    category: 'ratio',
    difficulty: 'hard',
    failure_class: 'metric_column_confusion',
    tags: ['paid_amount', 'net_payable', 'share', 'single_month'],
    phrasings: ['What percentage of the amount payable on March 2026 documents has been collected so far?', 'Collection rate on March 2026 billing: paid as a % of the payable amount.'],
    sql: `SELECT ROUND(100 * SUM(COALESCE(d.PaidAmount, 0)) / SUM(COALESCE(d.NetPayableAmount, 0)), 2) AS collected_pct FROM SalesDocument d WHERE ${NC} AND ${MAR_2026}`,
    comparison: { mode: 'scalar', decimals: 2, tolerance: 0.01 },
    notes: 'Paid amount over NetPayableAmount. PaidAmount + BalanceAmount equals NetPayableAmount on every fixture, so paid / (paid + balance) is the same answer.',
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['end'],
      ['month_only', '2026-03'],
      ['metric', 'd.NetPayableAmount', 'd.NetAmount', 'net amount as the denominator instead of the payable amount'],
      ['metric', 'd.PaidAmount', 'd.BalanceAmount', 'the still-open share instead of the collected share'],
    ],
    positive: [['rep', 'paid over paid plus balance (equal to the payable amount)', [['SUM(COALESCE(d.NetPayableAmount, 0))', 'SUM(COALESCE(d.PaidAmount, 0) + COALESCE(d.BalanceAmount, 0))']]]],
  },

  // ---- receivables ----
  {
    intentId: 'overdue_balance_asof_2026_04_15',
    category: 'relative_date',
    difficulty: 'medium',
    failure_class: 'relative_date',
    tags: ['outstanding_balance', 'due_date', 'as_of'],
    phrasings: ['As of 2026-04-15, how much do customers owe us on documents that are already past their due date?', typo('overdue AR as of 15 Apr 2026?')],
    sql: `SELECT ROUND(SUM(COALESCE(d.BalanceAmount, 0)), 2) AS overdue_balance FROM SalesDocument d WHERE ${NC} AND d.DueDate < '2026-04-15'`,
    comparison: { mode: 'scalar', decimals: 2, null_as_zero: ['overdue_balance'] },
    notes: 'Overdue on the as-of date: the open balance of non-canceled documents whose due date is before it (a document due that day is not yet overdue).',
    negative: [
      ['cancel'],
      ['rep', 'date_boundary', 'documents due on the as-of date counted as overdue (<=)', [["d.DueDate < '2026-04-15'", "d.DueDate <= '2026-04-15'"]]],
      ['rep', 'date_col', 'DocumentDate instead of DueDate', [['d.DueDate', 'd.DocumentDate']]],
      ['metric', 'd.BalanceAmount', 'd.NetPayableAmount', 'payable amount instead of the open balance'],
      ['rep', 'date_filter', 'balances not yet due instead of overdue ones (>=)', [["d.DueDate < '2026-04-15'", "d.DueDate >= '2026-04-15'"]]],
    ],
    positive: [['rep', 'past due written as DATEDIFF(as-of date, DueDate) > 0', [["d.DueDate < '2026-04-15'", "DATEDIFF('2026-04-15', d.DueDate) > 0"]]]],
  },
  {
    intentId: 'overdue_by_customer_asof_2026_04_30',
    category: 'relative_date',
    difficulty: 'hard',
    failure_class: 'relative_date',
    tags: ['outstanding_balance', 'due_date', 'customer', 'as_of'],
    phrasings: [
      sv('Vilka kunder har förfallna obetalda belopp per 2026-04-30? Visa belopp och antal dokument per kund.'),
      'Which customers had past-due open balances on 30 April 2026? Show how much each owes and on how many documents.',
    ],
    sql: `SELECT c.CustomerCode, c.CustomerName, ROUND(SUM(COALESCE(d.BalanceAmount, 0)), 2) AS overdue_balance, COUNT(*) AS overdue_documents FROM SalesDocument d ${CJ} WHERE ${NC} AND COALESCE(d.BalanceAmount, 0) > 0 AND d.DueDate < '2026-04-30' GROUP BY c.CustomerId, c.CustomerCode, c.CustomerName ORDER BY overdue_balance DESC, c.CustomerCode ASC`,
    comparison: { mode: 'rowset', compare_columns: ['CustomerName', 'overdue_balance', 'overdue_documents'], decimals: 2 },
    notes: 'Customers with documents due before the as-of date that still carry an open balance: the total of those balances and the number of those documents. Compared on the name, the amount and the count (the code may be left out); the two customers named Summit Grocers stay separate rows.',
    negative: [
      ['cancel'],
      ['rep', 'date_boundary', 'documents due on the as-of date counted as overdue (<=)', [["d.DueDate < '2026-04-30'", "d.DueDate <= '2026-04-30'"]]],
      ['rep', 'date_col', 'DocumentDate instead of DueDate', [['d.DueDate', 'd.DocumentDate']]],
      ['group_by_name', 'GROUP BY c.CustomerId, c.CustomerCode, c.CustomerName', 'GROUP BY c.CustomerName'],
      ['metric', 'd.BalanceAmount', 'd.NetPayableAmount', 'payable amount instead of the open balance'],
    ],
  },
  {
    intentId: 'ar_ageing_asof_2026_05_31',
    category: 'new_vocabulary',
    difficulty: 'hard',
    failure_class: 'aggregation_shape',
    tags: ['outstanding_balance', 'due_date', 'ageing', 'as_of', 'pivot'],
    phrasings: [
      'Age our open receivables as at 31 May 2026, in one row: not yet due, 1-30 days past due, 31-60, 61-90 and more than 90 days.',
      'AR ageing at 2026-05-31 — open balance by days overdue (current, 1-30, 31-60, 61-90, 90+), one row please.',
    ],
    sql: s(`SELECT
      ROUND(SUM(CASE WHEN DATEDIFF('2026-05-31', d.DueDate) <= 0 THEN COALESCE(d.BalanceAmount, 0) ELSE 0 END), 2) AS not_yet_due,
      ROUND(SUM(CASE WHEN DATEDIFF('2026-05-31', d.DueDate) BETWEEN 1 AND 30 THEN COALESCE(d.BalanceAmount, 0) ELSE 0 END), 2) AS days_1_30,
      ROUND(SUM(CASE WHEN DATEDIFF('2026-05-31', d.DueDate) BETWEEN 31 AND 60 THEN COALESCE(d.BalanceAmount, 0) ELSE 0 END), 2) AS days_31_60,
      ROUND(SUM(CASE WHEN DATEDIFF('2026-05-31', d.DueDate) BETWEEN 61 AND 90 THEN COALESCE(d.BalanceAmount, 0) ELSE 0 END), 2) AS days_61_90,
      ROUND(SUM(CASE WHEN DATEDIFF('2026-05-31', d.DueDate) > 90 THEN COALESCE(d.BalanceAmount, 0) ELSE 0 END), 2) AS over_90
      FROM SalesDocument d WHERE ${NC} AND COALESCE(d.BalanceAmount, 0) > 0`),
    comparison: {
      mode: 'rowset',
      decimals: 2,
      column_order: ['not_yet_due', 'days_1_30', 'days_31_60', 'days_61_90', 'over_90'],
      null_as_zero: ['not_yet_due', 'days_1_30', 'days_31_60', 'days_61_90', 'over_90'],
    },
    notes: "Days past due = DATEDIFF(as-of date, DueDate); a document due on the as-of date is not yet due. One row, buckets in the asked order (column_order), NULL as 0. No fixture has a document dated after 2026-05-31.",
    negative: [
      ['cancel'],
      ['rep', 'date_col', 'aged from the document date instead of the due date', [['d.DueDate', 'd.DocumentDate']]],
      ['metric', 'd.BalanceAmount', 'd.NetPayableAmount', 'payable amount instead of the open balance'],
    ],
    heldout: [['rep', 'date_boundary', 'balances due on the as-of date put in the 1-30 bucket', [['<= 0 THEN', '< 0 THEN'], ['BETWEEN 1 AND 30', 'BETWEEN 0 AND 30']]]],
  },
  {
    intentId: 'largest_open_items_top5',
    category: 'ranking_ties',
    difficulty: 'medium',
    failure_class: 'metric_column_confusion',
    tags: ['outstanding_balance', 'document', 'ranking', 'all_time'],
    phrasings: ['List the five documents with the largest unpaid balance, with document number, customer and balance; break ties by document number.', typo('top 5 open items by balance (doc no, customer, amount)')],
    sql: `SELECT d.DocumentNo, c.CustomerName, ROUND(COALESCE(d.BalanceAmount, 0), 2) AS open_balance FROM SalesDocument d ${CJ} WHERE ${NC} ORDER BY COALESCE(d.BalanceAmount, 0) DESC, d.DocumentNo ASC LIMIT 5`,
    comparison: { mode: 'ranked', value_columns: ['open_balance'], order: 'desc', decimals: 2 },
    negative: [
      ['cancel'],
      ['metric', 'd.BalanceAmount', 'd.NetPayableAmount', 'payable amount instead of the open balance'],
      ['metric', 'd.BalanceAmount', 'd.NetAmount', 'net amount instead of the open balance'],
      ['rep', 'order_limit', 'sorted ascending instead of descending', [['0) DESC', '0) ASC']]],
      ['rep', 'order_limit', 'LIMIT 5 missing', [[' LIMIT 5', '']]],
    ],
    positive: [
      [
        'sql',
        'a derived table, sorted and limited outside',
        `SELECT x.DocumentNo, x.CustomerName, x.balance FROM (SELECT d.DocumentNo, c.CustomerName, ROUND(d.BalanceAmount, 2) AS balance FROM SalesDocument d ${CJ} WHERE ${NC}) x ORDER BY x.balance DESC, x.DocumentNo ASC LIMIT 5`,
      ],
    ],
  },
  {
    intentId: 'customer_paid_vs_open_q1_2026',
    category: 'finance',
    difficulty: 'medium',
    failure_class: 'metric_column_confusion',
    tags: ['paid_amount', 'outstanding_balance', 'customer', 'quarter'],
    phrasings: ['For each customer, how much of what we billed in Q1 2026 has been paid and how much is still open?', 'Per client: paid vs still-outstanding amounts on Q1 2026 documents.'],
    sql: `SELECT c.CustomerName, ROUND(SUM(COALESCE(d.PaidAmount, 0)), 2) AS paid_amount, ROUND(SUM(COALESCE(d.BalanceAmount, 0)), 2) AS open_balance FROM SalesDocument d ${CJ} WHERE ${NC} AND ${Q1_2026} GROUP BY c.CustomerId, c.CustomerName ORDER BY c.CustomerName ASC`,
    comparison: { mode: 'rowset', decimals: 2 },
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['end'],
      ['group_by_name'],
      ['metric', 'd.BalanceAmount', 'd.NetPayableAmount', 'payable amount instead of the open balance'],
      ['metric', 'd.PaidAmount', 'd.NetAmount', 'net amount instead of the paid amount'],
      ['sum_distinct'],
    ],
    heldout: [['quarter_only', '2026-01-01', '2026-04-01', 1]],
    positive: [['between', '2026-01-01', '2026-04-01']],
  },
  {
    intentId: 'payment_terms_by_segment_2026',
    category: 'finance',
    difficulty: 'medium',
    failure_class: 'wrong_date_column',
    tags: ['due_date', 'customer_segment', 'date_arithmetic', 'year'],
    phrasings: ['What are our average payment terms in days (due date minus document date) for each customer segment, over documents dated in 2026?', 'Avg days from document date to due date by segment, 2026.'],
    sql: `SELECT c.CustomerSegment, ROUND(AVG(DATEDIFF(d.DueDate, d.DocumentDate)), 2) AS avg_terms_days FROM SalesDocument d ${CJ} WHERE ${NC} AND ${Y2026} GROUP BY c.CustomerSegment ORDER BY c.CustomerSegment ASC`,
    comparison: { mode: 'rowset', decimals: 2, tolerance: 0.01 },
    negative: [
      ['cancel'],
      ['start'],
      ['fan_out', 'every line counted as a document (joined to SalesDocumentLine)'],
      ['rep', 'date_col', 'terms measured from the posting date', [['DATEDIFF(d.DueDate, d.DocumentDate)', 'DATEDIFF(d.DueDate, d.PostingDate)']]],
      ['rep', 'date_col', 'documents selected by due date instead of document date', [[Y2026, win('2026-01-01', '2027-01-01', 'd.DueDate')]]],
    ],
    not_emitted: [
      fixtureLimit('date_boundary', BOUNDARY_NOTES.end, NO_2027),
    ],
  },
  {
    intentId: 'posting_lag_by_store_q1_2026',
    category: 'finance',
    difficulty: 'medium',
    failure_class: 'wrong_date_column',
    tags: ['posting_date', 'store_location', 'date_arithmetic', 'quarter'],
    phrasings: [
      "On average, how many days pass between a document's date and its posting date at each store, for documents dated in Q1 2026?",
      typo('avg booking delay in days per store, Q1 2026 docs'),
    ],
    sql: `SELECT s.LocationName, ROUND(AVG(DATEDIFF(d.PostingDate, d.DocumentDate)), 2) AS avg_posting_lag_days FROM SalesDocument d ${SJ} WHERE ${NC} AND ${Q1_2026} GROUP BY s.StoreLocationId, s.LocationName ORDER BY s.LocationName ASC`,
    comparison: { mode: 'rowset', decimals: 2, tolerance: 0.01 },
    negative: [
      ['cancel'],
      ['rep', 'date_col', 'documents selected by posting date instead of document date', [[Q1_2026, win('2026-01-01', '2026-04-01', 'd.PostingDate')]]],
      ['start'],
      ['end'],
      ['fan_out', 'every line counted as a document (joined to SalesDocumentLine)'],
    ],
    heldout: [['rep', 'metric', 'MAX instead of AVG', [['AVG(DATEDIFF', 'MAX(DATEDIFF']]]],
  },
  {
    intentId: 'march_docs_booked_april_or_later',
    category: 'finance',
    difficulty: 'medium',
    failure_class: 'wrong_date_column',
    tags: ['posting_date', 'document_count', 'cut_off', 'single_month'],
    phrasings: ['How many documents dated in March 2026 were not booked until April or later?', 'Count of March 2026 documents whose posting date falls in April 2026 or after.'],
    sql: `SELECT COUNT(*) AS document_count FROM SalesDocument d WHERE ${NC} AND ${MAR_2026} AND d.PostingDate >= '2026-04-01'`,
    comparison: { mode: 'scalar' },
    negative: [
      ['cancel'],
      ['end'],
      ['fan_out', 'every line counted as a document (joined to SalesDocumentLine)'],
      ['rep', 'date_filter', 'any posting after the document date counted (PostingDate > DocumentDate)', [["d.PostingDate >= '2026-04-01'", 'd.PostingDate > d.DocumentDate']]],
    ],
    heldout: [['rep', 'date_boundary', "posted after 1 April only (> '2026-04-01')", [["d.PostingDate >= '2026-04-01'", "d.PostingDate > '2026-04-01'"]]]],
  },
  {
    intentId: 'due_rest_of_month_asof_2026_05_10',
    category: 'relative_date',
    difficulty: 'medium',
    failure_class: 'relative_date',
    tags: ['outstanding_balance', 'due_date', 'as_of'],
    phrasings: ['As of 10 May 2026, how much open balance falls due between today and the end of the month, both days included?', 'Open balance due from 2026-05-10 through 2026-05-31 inclusive (as of 10 May 2026)?'],
    sql: `SELECT ROUND(SUM(COALESCE(d.BalanceAmount, 0)), 2) AS balance_due FROM SalesDocument d WHERE ${NC} AND ${win('2026-05-10', '2026-06-01', 'd.DueDate')}`,
    comparison: { mode: 'scalar', decimals: 2, null_as_zero: ['balance_due'] },
    negative: [
      ['cancel'],
      ['rep', 'date_col', 'DocumentDate instead of DueDate', [['d.DueDate', 'd.DocumentDate']]],
      ['metric', 'd.BalanceAmount', 'd.NetPayableAmount', 'payable amount instead of the open balance'],
      ['rep', 'date_filter', 'already overdue balances included (no lower bound)', [["d.DueDate >= '2026-05-10' AND ", '']]],
      ['start', 'd.DueDate'],
      ['end', 'd.DueDate'],
      ['rep', 'date_boundary', 'the last day (31 May) left out', [["d.DueDate < '2026-06-01'", "d.DueDate < '2026-05-31'"]]],
    ],
  },

  // ---- ledger ----
  {
    intentId: 'sales_tax_booked_mar_2026',
    category: 'multilingual',
    difficulty: 'hard',
    failure_class: 'vocabulary',
    tags: ['accounting', 'credit', 'posting_date', 'single_month'],
    phrasings: [sv('Hur mycket moms bokfördes i mars 2026?'), 'How much sales tax did we book in March 2026, going by posting date?'],
    sql: `SELECT ROUND(SUM(COALESCE(p.CreditAmount, 0)), 2) AS total_credit FROM AccountingPosting p ${AJ} WHERE a.AccountCode = '2100' AND ${win('2026-03-01', '2026-04-01', 'p.PostingDate')}`,
    alternatives: (sql) => [ledgerCancelAlternative(sql)],
    comparison: { mode: 'scalar', decimals: 2, null_as_zero: ['total_credit'] },
    notes: `Sales tax (moms) is booked as credits to account 2100 (Sales Tax Payable); no fixture debits that account, so credits minus debits is the same answer. ${LEDGER_NOTE}`,
    negative: [
      [
        'sql',
        'date_col',
        'SalesDocument.DocumentDate instead of AccountingPosting.PostingDate',
        `SELECT ROUND(SUM(COALESCE(p.CreditAmount, 0)), 2) AS total_credit FROM AccountingPosting p ${AJ} JOIN SalesDocument d ON p.SalesDocumentId = d.SalesDocumentId WHERE a.AccountCode = '2100' AND ${MAR_2026}`,
      ],
      ['start', 'p.PostingDate'],
      ['end', 'p.PostingDate'],
      ['month_only', '2026-03', 'p.PostingDate'],
      ['metric', 'p.CreditAmount', 'p.DebitAmount', 'debits instead of credits'],
      ['rep', 'filter', 'account 4000 instead of the tax account 2100', [["a.AccountCode = '2100'", "a.AccountCode = '4000'"]]],
    ],
  },
  {
    intentId: 'ledger_gross_margin_q1_2026',
    category: 'finance',
    difficulty: 'hard',
    failure_class: 'metric_column_confusion',
    tags: ['accounting', 'debit', 'credit', 'posting_date', 'quarter'],
    phrasings: [
      'From the books, what was our gross margin for Q1 2026 by posting date: income on account 4000 net of any debits, less cost of sales on account 5000?',
      'Q1 2026 gross profit per the ledger (4000 credits minus debits, less 5000 debits minus credits), by posting date.',
    ],
    sql: `SELECT ROUND(SUM(COALESCE(p.CreditAmount, 0) - COALESCE(p.DebitAmount, 0)), 2) AS gross_margin FROM AccountingPosting p ${AJ} WHERE a.AccountCode IN ('4000', '5000') AND ${win('2026-01-01', '2026-04-01', 'p.PostingDate')}`,
    alternatives: (sql) => [ledgerCancelAlternative(sql)],
    comparison: { mode: 'scalar', decimals: 2, null_as_zero: ['gross_margin'] },
    notes: `(credits - debits on 4000) - (debits - credits on 5000) = credits - debits over both accounts. ${LEDGER_NOTE}`,
    negative: [
      [
        'rep',
        'metric',
        'the debits on 4000 (adjustments) ignored',
        [['SUM(COALESCE(p.CreditAmount, 0) - COALESCE(p.DebitAmount, 0))', "SUM(CASE WHEN a.AccountCode = '4000' THEN COALESCE(p.CreditAmount, 0) ELSE -COALESCE(p.DebitAmount, 0) END)"]],
      ],
      [
        'rep',
        'metric',
        'cost of sales added instead of subtracted',
        [['SUM(COALESCE(p.CreditAmount, 0) - COALESCE(p.DebitAmount, 0))', "SUM(CASE WHEN a.AccountCode = '4000' THEN COALESCE(p.CreditAmount, 0) - COALESCE(p.DebitAmount, 0) ELSE COALESCE(p.DebitAmount, 0) - COALESCE(p.CreditAmount, 0) END)"]],
      ],
      [
        'sql',
        'date_col',
        'SalesDocument.DocumentDate instead of AccountingPosting.PostingDate',
        `SELECT ROUND(SUM(COALESCE(p.CreditAmount, 0) - COALESCE(p.DebitAmount, 0)), 2) AS gross_margin FROM AccountingPosting p ${AJ} JOIN SalesDocument d ON p.SalesDocumentId = d.SalesDocumentId WHERE a.AccountCode IN ('4000', '5000') AND ${Q1_2026}`,
      ],
      ['start', 'p.PostingDate'],
      ['end', 'p.PostingDate'],
    ],
    heldout: [['quarter_only', '2026-01-01', '2026-04-01', 1, 'p.PostingDate']],
  },
  {
    intentId: 'trial_balance_asof_2026_03_31',
    category: 'finance',
    difficulty: 'hard',
    failure_class: 'time_window',
    tags: ['accounting', 'debit', 'credit', 'posting_date', 'as_of'],
    phrasings: ['Give me a trial balance as at 31 March 2026: for each account name, total debits, total credits and debits minus credits for everything posted up to and including that date.'],
    sql: s(`SELECT a.AccountName, ROUND(SUM(COALESCE(p.DebitAmount, 0)), 2) AS total_debit, ROUND(SUM(COALESCE(p.CreditAmount, 0)), 2) AS total_credit,
      ROUND(SUM(COALESCE(p.DebitAmount, 0) - COALESCE(p.CreditAmount, 0)), 2) AS balance
      FROM AccountingPosting p ${AJ} WHERE p.PostingDate < '2026-04-01' GROUP BY a.LedgerAccountId, a.AccountName ORDER BY a.AccountName ASC`),
    alternatives: (sql) => [ledgerCancelAlternative(sql)],
    comparison: { mode: 'rowset', compare_columns: ['AccountName', 'total_debit', 'total_credit', 'balance'], decimals: 2 },
    notes: `Cumulative: every posting dated on or before the as-of date, in any year. ${LEDGER_NOTE}`,
    negative: [
      ['rep', 'date_boundary', 'postings on 1 April included (<=)', [["p.PostingDate < '2026-04-01'", "p.PostingDate <= '2026-04-01'"]]],
      ['rep', 'date_boundary', 'postings on 31 March left out', [["p.PostingDate < '2026-04-01'", "p.PostingDate < '2026-03-31'"]]],
      ['rep', 'time_window', 'only 2026 postings instead of everything to date', [["p.PostingDate < '2026-04-01'", "p.PostingDate >= '2026-01-01' AND p.PostingDate < '2026-04-01'"]]],
      [
        'rep',
        'date_col',
        'SalesDocument.DocumentDate instead of AccountingPosting.PostingDate (manual journals dropped too)',
        [[`${AJ} WHERE p.PostingDate < '2026-04-01'`, `${AJ} JOIN SalesDocument d ON p.SalesDocumentId = d.SalesDocumentId WHERE d.DocumentDate < '2026-04-01'`]],
      ],
      ['rep', 'metric', 'credits minus debits as the balance', [['SUM(COALESCE(p.DebitAmount, 0) - COALESCE(p.CreditAmount, 0))', 'SUM(COALESCE(p.CreditAmount, 0) - COALESCE(p.DebitAmount, 0))']]],
    ],
    positive: [['rep', 'the balance as the difference of the two sums', [['ROUND(SUM(COALESCE(p.DebitAmount, 0) - COALESCE(p.CreditAmount, 0)), 2) AS balance', 'ROUND(SUM(COALESCE(p.DebitAmount, 0)) - SUM(COALESCE(p.CreditAmount, 0)), 2) AS balance']]]],
  },
  {
    intentId: 'manual_entries_by_account_2026',
    category: 'finance',
    difficulty: 'hard',
    failure_class: 'wrong_join_path',
    tags: ['accounting', 'manual_journal', 'debit', 'credit', 'year'],
    phrasings: [
      'Which accounts did our manual adjustments (entries with no invoice, order or receipt behind them) touch in 2026, and what were the debits and credits on each?',
      '2026 manual journal entries by account name: total debits and credits.',
    ],
    sql: `SELECT a.AccountName, ROUND(SUM(COALESCE(p.DebitAmount, 0)), 2) AS total_debit, ROUND(SUM(COALESCE(p.CreditAmount, 0)), 2) AS total_credit FROM AccountingPosting p ${AJ} WHERE p.SalesDocumentId IS NULL AND ${win('2026-01-01', '2027-01-01', 'p.PostingDate')} GROUP BY a.LedgerAccountId, a.AccountName ORDER BY a.AccountName ASC`,
    comparison: { mode: 'rowset', compare_columns: ['AccountName', 'total_debit', 'total_credit'], decimals: 2 },
    notes: 'Manual journals are the postings with no sales document (SalesDocumentId IS NULL), selected by PostingDate. Rows are compared on the account name and both amounts.',
    negative: [
      ['rep', 'filter', 'manual-entry filter dropped (every posting)', [['p.SalesDocumentId IS NULL AND ', '']]],
      ['start', 'p.PostingDate'],
      [
        'rep',
        'metric',
        'debit and credit swapped',
        [
          ['ROUND(SUM(COALESCE(p.DebitAmount, 0)), 2) AS total_debit', 'ROUND(SUM(COALESCE(p.CreditAmount, 0)), 2) AS total_debit_x'],
          ['ROUND(SUM(COALESCE(p.CreditAmount, 0)), 2) AS total_credit', 'ROUND(SUM(COALESCE(p.DebitAmount, 0)), 2) AS total_credit'],
          ['total_debit_x', 'total_debit'],
        ],
      ],
      ['rep', 'time_window', 'every year instead of 2026', [[` AND ${win('2026-01-01', '2027-01-01', 'p.PostingDate')}`, '']]],
    ],
    not_emitted: [
      fixtureLimit('date_boundary', BOUNDARY_NOTES.end, NO_2027),
    ],
  },
  {
    intentId: 'receivable_net_change_monthly_2026',
    category: 'finance',
    difficulty: 'hard',
    failure_class: 'aggregation_shape',
    tags: ['accounting', 'debit', 'credit', 'posting_date', 'time_series', 'year'],
    phrasings: [
      'Month by month in 2026, how much did the amount customers owe us change on account 1100 — debits less credits, by posting date?',
      'Monthly net change on the 1100 account in 2026 (debit minus credit, posting date).',
    ],
    series: (label) =>
      `SELECT ${label('p.PostingDate')} AS month, ROUND(SUM(COALESCE(p.DebitAmount, 0) - COALESCE(p.CreditAmount, 0)), 2) AS net_change FROM AccountingPosting p ${AJ} WHERE a.AccountCode = '1100' AND ${win('2026-01-01', '2027-01-01', 'p.PostingDate')} GROUP BY ${label('p.PostingDate')} ORDER BY month ASC`,
    seriesLabels: ONE_YEAR_LABELS,
    alternatives: (sql) => [ledgerCancelAlternative(sql)],
    comparison: { mode: 'rowset', decimals: 2 },
    notes: `${SERIES_NOTE} ${LEDGER_NOTE}`,
    negative: [
      [
        'sql',
        'date_col',
        'SalesDocument.DocumentDate instead of AccountingPosting.PostingDate',
        `SELECT DATE_FORMAT(d.DocumentDate, '%Y-%m') AS month, ROUND(SUM(COALESCE(p.DebitAmount, 0) - COALESCE(p.CreditAmount, 0)), 2) AS net_change FROM AccountingPosting p ${AJ} JOIN SalesDocument d ON p.SalesDocumentId = d.SalesDocumentId WHERE a.AccountCode = '1100' AND ${Y2026} GROUP BY DATE_FORMAT(d.DocumentDate, '%Y-%m') ORDER BY month ASC`,
      ],
      ['rep', 'metric', 'credits minus debits', [['SUM(COALESCE(p.DebitAmount, 0) - COALESCE(p.CreditAmount, 0))', 'SUM(COALESCE(p.CreditAmount, 0) - COALESCE(p.DebitAmount, 0))']]],
      ['rep', 'metric', 'debits only', [['SUM(COALESCE(p.DebitAmount, 0) - COALESCE(p.CreditAmount, 0))', 'SUM(COALESCE(p.DebitAmount, 0))']]],
      ['rep', 'group_by', 'the month dropped from GROUP BY: one row for the whole year under an arbitrary month label', [[" GROUP BY DATE_FORMAT(p.PostingDate, '%Y-%m')", '']]],
      ['start', 'p.PostingDate'],
    ],
    not_emitted: [
      fixtureLimit('date_boundary', BOUNDARY_NOTES.end, NO_2027),
    ],
  },
  {
    intentId: 'sales_revenue_debits_2026',
    category: 'named_entity',
    difficulty: 'medium',
    failure_class: 'entity_filter',
    tags: ['accounting', 'debit', 'posting_date', 'year'],
    phrasings: [
      { q: 'How much was debited to Sales Revenue in 2026 (reversals and adjustments), and in how many debit postings?', knownRejection: 'METRIC_COLUMN' },
      { q: 'Debits booked against Sales Revenue during 2026: total and number of postings.', knownRejection: 'METRIC_COLUMN' },
    ],
    sql: `SELECT ROUND(SUM(COALESCE(p.DebitAmount, 0)), 2) AS total_debit, COUNT(*) AS posting_count FROM AccountingPosting p ${AJ} WHERE a.AccountName = 'Sales Revenue' AND COALESCE(p.DebitAmount, 0) > 0 AND ${win('2026-01-01', '2027-01-01', 'p.PostingDate')}`,
    comparison: { mode: 'rowset', decimals: 2, null_as_zero: ['total_debit'] },
    notes:
      'Postings to the Sales Revenue account (code 4000) with a debit, by PostingDate; the count is of those debit postings. One row (NULL / 0 where there are none). Known validator rejection: the account name "Sales Revenue" trips the net-sales metric guardrail on a ledger question (as in tpl_revenue_credits_monthly_q1_2026).',
    negative: [
      ['metric', 'p.DebitAmount', 'p.CreditAmount', 'credits instead of debits'],
      ['rep', 'count', 'every Sales Revenue posting counted, credit ones included', [['COALESCE(p.DebitAmount, 0) > 0 AND ', '']]],
      ['rep', 'filter', 'account filter dropped', [["a.AccountName = 'Sales Revenue' AND ", '']]],
      [
        'rep',
        'join_type',
        'inner join to SalesDocument drops the manual adjustments',
        [[`${AJ} WHERE`, `${AJ} JOIN SalesDocument d ON p.SalesDocumentId = d.SalesDocumentId WHERE`]],
      ],
    ],
    not_emitted: [
      fixtureLimit('date_boundary', BOUNDARY_NOTES.start, 'no Sales Revenue debit is posted on 2026-01-01 on any fixture'),
      fixtureLimit('date_boundary', BOUNDARY_NOTES.end, NO_2027),
    ],
  },

  // ---- products and lines ----
  {
    intentId: 'avg_unit_price_by_product_q1_2026',
    category: 'standard',
    difficulty: 'hard',
    failure_class: 'ratio_metric',
    tags: ['line_net_sales', 'quantity', 'product', 'quarter'],
    phrasings: ['What was the average realised price per unit for each product in Q1 2026, i.e. line net amount divided by units?', 'Q1 2026 net price per unit by product.'],
    sql: `SELECT p.ProductName, ROUND(${LNET} / ${QTY}, 2) AS avg_unit_price FROM ${LINES} ${PJ} WHERE ${NC} AND ${Q1_2026} GROUP BY p.ProductId, p.ProductName ORDER BY p.ProductName ASC`,
    comparison: { mode: 'rowset', decimals: 2, tolerance: 0.01 },
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['end'],
      ['metric', 'l.NetAmount', 'l.TotalAmount', 'line TotalAmount (before adjustments) instead of line NetAmount'],
    ],
    heldout: [
      ['quarter_only', '2026-01-01', '2026-04-01', 1],
      ['rep', 'ratio', 'unweighted average of the line SalePrice instead of net per unit', [[`${LNET} / ${QTY}`, 'AVG(l.SalePrice)']]],
    ],
  },
  {
    intentId: 'rice_price_range_2026',
    category: 'named_entity',
    difficulty: 'medium',
    failure_class: 'entity_filter',
    tags: ['unit_price', 'product', 'filter_product', 'year'],
    phrasings: ['What were the lowest and highest unit prices we charged for Long Grain Rice 5kg in 2026?', 'Min and max selling price per unit of Long Grain Rice 5kg, 2026.'],
    sql: `SELECT ROUND(MIN(l.SalePrice), 2) AS lowest_unit_price, ROUND(MAX(l.SalePrice), 2) AS highest_unit_price FROM ${LINES} ${PJ} WHERE ${NC} AND p.ProductName = 'Long Grain Rice 5kg' AND ${Y2026}`,
    comparison: { mode: 'rowset', decimals: 2, column_order: ['lowest_unit_price', 'highest_unit_price'] },
    negative: [
      ['rep', 'filter', 'product filter dropped', [["p.ProductName = 'Long Grain Rice 5kg' AND ", '']]],
      ['rep', 'metric', 'line net amount instead of the unit price', [['MIN(l.SalePrice)', 'MIN(l.NetAmount)'], ['MAX(l.SalePrice)', 'MAX(l.NetAmount)']]],
      ['rep', 'time_window', 'every year instead of 2026', [[` AND ${Y2026}`, '']]],
    ],
    not_emitted: [
      fixtureLimit('date_boundary', BOUNDARY_NOTES.start, 'no rice line is dated 2026-01-01'),
      fixtureLimit('cancel', 'canceled documents not excluded', 'no canceled 2026 rice line has a price outside the range of the live ones'),
      fixtureLimit('date_boundary', BOUNDARY_NOTES.end, NO_2027),
    ],
    heldout: [['rep', 'stale_snapshot', 'filter on the line snapshot l.ProductNameSnapshot instead of the product master data', [[`${PJ} `, ''], ["p.ProductName = 'Long Grain Rice 5kg'", "l.ProductNameSnapshot LIKE '%Rice%'"]]]],
  },
  {
    intentId: 'best_seller_per_category_mar_2026',
    category: 'ranking_ties',
    difficulty: 'hard',
    failure_class: 'aggregation_shape',
    tags: ['quantity', 'product', 'product_category', 'window_function', 'single_month'],
    phrasings: [
      'For each category, which product shifted the most units in March 2026? If two tie, take the one that comes first alphabetically.',
      'Top-selling item by units in every category, March 2026 (ties: alphabetical).',
    ],
    sql: s(`SELECT x.CategoryName, x.ProductName, x.total_qty FROM (
      SELECT pc.CategoryName, p.ProductName, ROUND(${QTY}, 3) AS total_qty,
        ROW_NUMBER() OVER (PARTITION BY pc.ProductCategoryId ORDER BY ${QTY} DESC, p.ProductName ASC) AS rn
      FROM ${LINES} ${PJ} ${PCJ} WHERE ${NC} AND ${MAR_2026}
      GROUP BY pc.ProductCategoryId, pc.CategoryName, p.ProductId, p.ProductName) x
      WHERE x.rn = 1 ORDER BY x.CategoryName ASC`),
    comparison: { mode: 'rowset', decimals: 3 },
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['end'],
      ['month_only', '2026-03'],
      ['metric', 'l.Quantity', 'l.NetAmount', 'line net amount instead of units'],
      [
        'rep',
        'stale_snapshot',
        'grouped by the stale l.CategoryNameSnapshot instead of the category master data',
        [
          [` ${PCJ}`, ''],
          ['SELECT pc.CategoryName, p.ProductName', 'SELECT l.CategoryNameSnapshot AS CategoryName, p.ProductName'],
          ['PARTITION BY pc.ProductCategoryId', 'PARTITION BY l.CategoryNameSnapshot'],
          ['GROUP BY pc.ProductCategoryId, pc.CategoryName,', 'GROUP BY l.CategoryNameSnapshot,'],
        ],
      ],
    ],
    heldout: [['rep', 'order_limit', 'ties broken by the last name alphabetically', [['DESC, p.ProductName ASC', 'DESC, p.ProductName DESC']]]],
    not_emitted: [
      fixtureLimit('join_path', "category through the brand's default category instead of Product.ProductCategoryId", 'Northstar Trail Crisps, the only product whose brand default category differs from its own, tops neither Snacks nor Beverages in March 2026'),
    ],
  },
  {
    intentId: 'distinct_products_per_document_q1_2026',
    category: 'standard',
    difficulty: 'hard',
    failure_class: 'distinct_count',
    tags: ['product', 'document', 'basket', 'quarter'],
    phrasings: ['On average, how many different products appear on one document in Q1 2026?', 'Avg number of distinct SKUs per document for Q1 2026.'],
    sql: `SELECT ROUND(AVG(x.product_count), 2) AS avg_products_per_document FROM (SELECT d.SalesDocumentId, COUNT(DISTINCT l.ProductId) AS product_count FROM SalesDocument d JOIN SalesDocumentLine l ON l.SalesDocumentId = d.SalesDocumentId WHERE ${NC} AND ${Q1_2026} GROUP BY d.SalesDocumentId) x`,
    comparison: { mode: 'scalar', decimals: 2, tolerance: 0.01 },
    notes: 'Every fixture document has at least one product line, so documents without products do not change the average.',
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['end'],
      ['rep', 'count', 'lines per document instead of distinct products', [['COUNT(DISTINCT l.ProductId)', 'COUNT(*)']]],
    ],
    heldout: [
      [
        'sql',
        'ratio',
        'distinct products over the whole quarter divided by the number of documents',
        `SELECT ROUND(COUNT(DISTINCT l.ProductId) / COUNT(DISTINCT d.SalesDocumentId), 2) AS avg_products_per_document FROM SalesDocument d JOIN SalesDocumentLine l ON l.SalesDocumentId = d.SalesDocumentId WHERE ${NC} AND ${Q1_2026}`,
      ],
    ],
  },
  {
    intentId: 'units_per_document_by_store_feb_2026',
    category: 'standard',
    difficulty: 'hard',
    failure_class: 'grain_confusion',
    tags: ['quantity', 'store_location', 'basket', 'single_month'],
    phrasings: ['Average units per document at each store in February 2026 (total product units divided by the number of documents).', 'Units per basket by outlet, Feb 2026.'],
    sql: `SELECT s.LocationName, ROUND(${QTY} / COUNT(DISTINCT d.SalesDocumentId), 2) AS avg_units_per_document FROM ${LINES} ${SJ} WHERE ${NC} AND l.ProductId IS NOT NULL AND ${FEB_2026} GROUP BY s.StoreLocationId, s.LocationName ORDER BY s.LocationName ASC`,
    comparison: { mode: 'rowset', decimals: 2, tolerance: 0.01 },
    notes: 'Product units only (the NULL-ProductId delivery-fee lines are not units); every fixture document has a product line, so the document count is the same with or without them.',
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['end'],
      ['month_only', '2026-02'],
      ['rep', 'filter', 'the NULL-ProductId delivery-fee lines counted as units', [['l.ProductId IS NOT NULL AND ', '']]],
      ['rep', 'count', 'divided by the number of lines instead of documents', [['COUNT(DISTINCT d.SalesDocumentId)', 'COUNT(*)']]],
    ],
  },
  {
    intentId: 'delisted_products_sold_2026',
    category: 'new_vocabulary',
    difficulty: 'medium',
    failure_class: 'entity_filter',
    tags: ['quantity', 'product', 'inactive', 'year'],
    phrasings: ['Which delisted products still sold in 2026, and how many units of each?', 'Discontinued SKUs with 2026 sales — units per item.'],
    sql: `SELECT p.ProductName, ROUND(${QTY}, 3) AS total_qty FROM ${LINES} ${PJ} WHERE ${NC} AND p.IsActive = 0 AND ${Y2026} GROUP BY p.ProductId, p.ProductName ORDER BY total_qty DESC, p.ProductName ASC`,
    comparison: { mode: 'rowset', decimals: 3 },
    notes: 'Delisted / discontinued = Product.IsActive = 0.',
    negative: [
      ['cancel'],
      ['rep', 'filter', 'delisted filter dropped (every product)', [['p.IsActive = 0 AND ', '']]],
      ['rep', 'filter', 'active products instead of delisted ones', [['p.IsActive = 0', 'p.IsActive = 1']]],
      ['rep', 'time_window', 'every year instead of 2026', [[` AND ${Y2026}`, '']]],
    ],
    not_emitted: [
      fixtureLimit('date_boundary', BOUNDARY_NOTES.start, 'the delisted product has no sale dated 2026-01-01'),
      fixtureLimit('date_boundary', BOUNDARY_NOTES.end, NO_2027),
    ],
  },
  {
    intentId: 'brands_per_customer_q1_2026',
    category: 'standard',
    difficulty: 'hard',
    failure_class: 'distinct_count',
    tags: ['brand', 'customer', 'distinct_count', 'quarter'],
    phrasings: ['How many different brands did each customer buy in Q1 2026?', typo('no. of distinct brands per client, Q1 2026')],
    sql: `SELECT c.CustomerName, COUNT(DISTINCT p.BrandId) AS brand_count FROM ${LINES} ${PJ} ${CJ} WHERE ${NC} AND ${Q1_2026} GROUP BY c.CustomerId, c.CustomerName ORDER BY brand_count DESC, c.CustomerName ASC`,
    comparison: { mode: 'rowset' },
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['end'],
      ['group_by_name'],
      ['rep', 'join_path', 'brand through the ProductBrand bridge (only some products have a row) instead of Product.BrandId', [['COUNT(DISTINCT p.BrandId)', 'COUNT(DISTINCT pb.BrandId)'], [PJ, `${PJ} JOIN ProductBrand pb ON pb.ProductId = p.ProductId`]]],
      ['rep', 'stale_snapshot', 'distinct stale l.BrandNameSnapshot values instead of brands', [['COUNT(DISTINCT p.BrandId)', 'COUNT(DISTINCT l.BrandNameSnapshot)']]],
      ['rep', 'count', 'lines counted instead of distinct brands', [['COUNT(DISTINCT p.BrandId)', 'COUNT(*)']]],
    ],
    heldout: [['quarter_only', '2026-01-01', '2026-04-01', 1]],
  },
  {
    intentId: 'customers_two_brands_mar_2026',
    category: 'named_entity',
    difficulty: 'hard',
    failure_class: 'entity_filter',
    tags: ['brand', 'customer', 'filter_brand', 'single_month'],
    phrasings: ['Which customers bought both Clearspring Waters and Homebase Supply products in March 2026?', 'Customers who purchased from Clearspring Waters as well as from Homebase Supply during March 2026.'],
    sql: `SELECT c.CustomerName FROM ${LINES} ${PJ} ${BJ} ${CJ} WHERE ${NC} AND ${MAR_2026} AND b.BrandName IN ('Clearspring Waters', 'Homebase Supply') GROUP BY c.CustomerId, c.CustomerName HAVING COUNT(DISTINCT b.BrandId) = 2 ORDER BY c.CustomerName ASC`,
    comparison: { mode: 'rowset' },
    negative: [
      ['cancel'],
      ['end'],
      ['month_only', '2026-03'],
      ['rep', 'filter', 'either brand instead of both', [[' HAVING COUNT(DISTINCT b.BrandId) = 2', '']]],
    ],
    heldout: [
      [
        'rep',
        'stale_snapshot',
        'brands taken from the stale l.BrandNameSnapshot instead of the brand master data',
        [[` ${BJ}`, ''], ["b.BrandName IN ('Clearspring Waters', 'Homebase Supply')", "l.BrandNameSnapshot IN ('Clearspring Waters', 'Homebase Supply')"], ['COUNT(DISTINCT b.BrandId)', 'COUNT(DISTINCT l.BrandNameSnapshot)']],
      ],
    ],
    not_emitted: [
      fixtureLimit('group_by', 'grouped by CustomerName only: the two customers named Summit Grocers are merged', 'only one of the two Summit Grocers buys both brands in March 2026'),
      fixtureLimit('date_boundary', BOUNDARY_NOTES.start, 'no Clearspring Waters or Homebase Supply line dated 2026-03-01 decides a customer'),
      fixtureLimit('date_col', 'PostingDate instead of DocumentDate', "selecting by posting date changes no customer's pair of brands in March 2026"),
    ],
  },
  {
    intentId: 'agreed_vs_charged_price_2026',
    category: 'ambiguous',
    difficulty: 'hard',
    failure_class: 'ambiguous_metric',
    tags: ['customer_price', 'unit_price', 'customer', 'product', 'year'],
    phrasings: [
      "For each special price agreement, show the customer, the product, the agreed price and the average unit price on that customer's 2026 lines for that product.",
      'Agreed vs actual: per customer price agreement, the agreed price next to the average unit price we charged that customer for the product in 2026.',
    ],
    sql: s(`SELECT c.CustomerName, p.ProductName, ROUND(cpp.SalePrice, 2) AS agreed_price, ROUND(AVG(x.SalePrice), 2) AS avg_charged_price
      FROM CustomerProductPrice cpp JOIN Customer c ON cpp.CustomerId = c.CustomerId JOIN Product p ON cpp.ProductId = p.ProductId
      LEFT JOIN (SELECT d.CustomerId, l.ProductId, l.SalePrice, l.Quantity FROM ${LINES} WHERE ${NC} AND ${Y2026}) x ON x.CustomerId = c.CustomerId AND x.ProductId = p.ProductId
      GROUP BY cpp.CustomerProductPriceId, c.CustomerName, p.ProductName, cpp.SalePrice ORDER BY c.CustomerName ASC, p.ProductName ASC`),
    alternatives: (sql) => [replaceAll(sql, 'ROUND(AVG(x.SalePrice), 2)', 'ROUND(SUM(x.SalePrice * x.Quantity) / SUM(x.Quantity), 2)')],
    comparison: { mode: 'rowset', compare_columns: ['CustomerName', 'ProductName', 'agreed_price', 'avg_charged_price'], decimals: 2, tolerance: 0.01 },
    notes:
      "Two readings of the average unit price are accepted: the plain average of the line SalePrice (the gold) and the quantity-weighted average (alternative_expected_sql). Every agreement is listed (LEFT JOIN; NULL where that customer did not buy the product in 2026).",
    negative: [
      ['cancel'],
      ['rep', 'filter', "every customer's lines for the product, not only the agreement's customer", [['x.CustomerId = c.CustomerId AND ', '']]],
      ['rep', 'time_window', 'every year instead of 2026', [[` AND ${Y2026}`, '']]],
      ['start'],
    ],
    heldout: [['rep', 'join_type', 'inner join: agreements without 2026 sales dropped', [['LEFT JOIN (SELECT', 'JOIN (SELECT']]]],
    not_emitted: [
      fixtureLimit('date_boundary', BOUNDARY_NOTES.end, NO_2027),
    ],
  },
  {
    intentId: 'largest_line_mar_2026',
    category: 'ranking_ties',
    difficulty: 'medium',
    failure_class: 'grain_confusion',
    tags: ['quantity', 'line', 'ranking', 'single_month'],
    phrasings: [
      'What was the single biggest line by units in March 2026? Give the document number, product and units; if lines tie, the lowest document number wins.',
      'Largest March 2026 line item by quantity: doc no, product, qty.',
    ],
    sql: `SELECT d.DocumentNo, p.ProductName, ROUND(COALESCE(l.Quantity, 0), 3) AS units FROM ${LINES} ${PJ} WHERE ${NC} AND ${MAR_2026} ORDER BY COALESCE(l.Quantity, 0) DESC, d.DocumentNo ASC, p.ProductName ASC LIMIT 1`,
    comparison: { mode: 'ranked', value_columns: ['units'], order: 'desc', decimals: 3 },
    negative: [
      ['cancel'],
      ['date_col'],
      ['rep', 'order_limit', 'smallest line instead of the largest', [['0) DESC', '0) ASC']]],
      ['rep', 'metric', 'largest line by net amount instead of units', [['ORDER BY COALESCE(l.Quantity, 0) DESC', 'ORDER BY COALESCE(l.NetAmount, 0) DESC']]],
    ],
    not_emitted: [
      fixtureLimit('date_filter', 'MONTH() without YEAR(): the same month of every year is included', 'no March 2025 line is larger than the largest March 2026 line'),
      fixtureLimit('date_boundary', BOUNDARY_NOTES.end, 'no line dated 2026-04-01 is larger than the largest March 2026 line'),
      fixtureLimit('date_boundary', BOUNDARY_NOTES.start, 'the largest March 2026 line is not on the first day and no 1 March line is larger'),
    ],
  },

  // ---- customers ----
  {
    intentId: 'new_customers_by_month_2026',
    category: 'standard',
    difficulty: 'hard',
    failure_class: 'aggregation_shape',
    tags: ['customer', 'first_purchase', 'time_series', 'year'],
    phrasings: [
      'In which months of 2026 did customers make their first-ever purchase with us, and how many new customers per month?',
      'New customer acquisition by month for 2026 (first purchase ever).',
    ],
    series: (label) =>
      `SELECT ${label('f.first_date')} AS month, COUNT(*) AS new_customers FROM (SELECT d.CustomerId, MIN(d.DocumentDate) AS first_date FROM SalesDocument d WHERE ${NC} GROUP BY d.CustomerId) f WHERE ${win('2026-01-01', '2027-01-01', 'f.first_date')} GROUP BY ${label('f.first_date')} ORDER BY month ASC`,
    seriesLabels: ONE_YEAR_LABELS,
    comparison: { mode: 'rowset' },
    notes: `A customer is new in the month of its first non-canceled document ever; months without a new customer are not listed. ${SERIES_NOTE}`,
    negative: [
      ['cancel'],
      [
        'sql',
        'time_window',
        'first purchase taken within 2026 only, so every 2026 buyer counts as new',
        `SELECT DATE_FORMAT(f.first_date, '%Y-%m') AS month, COUNT(*) AS new_customers FROM (SELECT d.CustomerId, MIN(d.DocumentDate) AS first_date FROM SalesDocument d WHERE ${NC} AND ${Y2026} GROUP BY d.CustomerId) f GROUP BY DATE_FORMAT(f.first_date, '%Y-%m') ORDER BY month ASC`,
      ],
      [
        'sql',
        'distinct_count',
        'buyers per month instead of first-time buyers',
        `SELECT DATE_FORMAT(d.DocumentDate, '%Y-%m') AS month, COUNT(DISTINCT d.CustomerId) AS new_customers FROM SalesDocument d WHERE ${NC} AND ${Y2026} GROUP BY DATE_FORMAT(d.DocumentDate, '%Y-%m') ORDER BY month ASC`,
      ],
    ],
    not_emitted: [
      fixtureLimit('date_col', 'first posting date instead of first document date', "moving to the first posting date changes no month's count of new customers"),
    ],
  },
  {
    intentId: 'lapsed_customers_asof_2026_05_31',
    category: 'ambiguous',
    difficulty: 'hard',
    failure_class: 'relative_date',
    tags: ['customer', 'last_purchase', 'as_of'],
    phrasings: ['As of 31 May 2026, which customers have bought from us before but not in the last 60 days?', 'Lapsed customers at 2026-05-31: no purchase in the past 60 days, but at least one earlier.'],
    sql: `SELECT c.CustomerName FROM SalesDocument d ${CJ} WHERE ${NC} AND d.DocumentDate <= '2026-05-31' GROUP BY c.CustomerId, c.CustomerName HAVING MAX(d.DocumentDate) < '2026-04-01' ORDER BY c.CustomerName ASC`,
    alternatives: (sql) => [replaceAll(sql, "HAVING MAX(d.DocumentDate) < '2026-04-01'", "HAVING MAX(d.DocumentDate) <= '2026-04-01'")],
    comparison: { mode: 'rowset' },
    notes:
      "Two readings of 'the last 60 days' as of 2026-05-31 are accepted: no purchase on or after 2026-04-01 (DATE_SUB by 60 days; the gold) and none after it (60 days counted back from the as-of date inclusive: 2 April to 31 May; alternative_expected_sql). Customers that never bought are not listed.",
    negative: [
      ['cancel'],
      ['rep', 'time_window', '90 days instead of 60', [["HAVING MAX(d.DocumentDate) < '2026-04-01'", "HAVING MAX(d.DocumentDate) < '2026-03-02'"]]],
      [
        'sql',
        'filter',
        'customers that never bought listed too',
        `SELECT c.CustomerName FROM Customer c LEFT JOIN SalesDocument d ON d.CustomerId = c.CustomerId AND ${NC} AND d.DocumentDate <= '2026-05-31' GROUP BY c.CustomerId, c.CustomerName HAVING MAX(d.DocumentDate) < '2026-04-01' OR MAX(d.DocumentDate) IS NULL ORDER BY c.CustomerName ASC`,
      ],
      ['group_by_name'],
    ],
    heldout: [['rep', 'filter', 'active customers only', [[`WHERE ${NC}`, `WHERE ${NC} AND c.IsActive = 1`]]]],
  },
  {
    intentId: 'repeat_customers_mar_2026',
    category: 'standard',
    difficulty: 'medium',
    failure_class: 'distinct_count',
    tags: ['customer', 'repeat', 'single_month'],
    phrasings: [
      'How many customers made more than one purchase in March 2026?',
      sv('Hur många kunder handlade mer än en gång i mars 2026?'),
      typo('how many repeat custmers did we have in mar 26 (2+ purchases)?'),
    ],
    sql: `SELECT COUNT(*) AS customer_count FROM (SELECT d.CustomerId FROM SalesDocument d WHERE ${NC} AND ${MAR_2026} GROUP BY d.CustomerId HAVING COUNT(*) > 1) x`,
    comparison: { mode: 'scalar' },
    notes: 'A purchase is a non-canceled document of any type (the suite-wide convention).',
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['end'],
      ['rep', 'count', 'every buyer counted (one purchase is enough)', [['HAVING COUNT(*) > 1', 'HAVING COUNT(*) >= 1']]],
      ['fan_out', 'lines counted as purchases (joined to SalesDocumentLine)'],
      ['rep', 'group_by', 'grouped by CustomerName only: the two customers named Summit Grocers are merged', [['SELECT d.CustomerId FROM SalesDocument d WHERE', `SELECT c.CustomerName FROM SalesDocument d ${CJ} WHERE`], ['GROUP BY d.CustomerId', 'GROUP BY c.CustomerName']]],
    ],
    not_emitted: [
      fixtureLimit('date_filter', 'MONTH() without YEAR(): the same month of every year is included', 'the March 2025 purchases make no further customer a repeat buyer'),
    ],
    positive: [['rep', 'documents counted with COUNT(DISTINCT SalesDocumentId)', [['HAVING COUNT(*) > 1', 'HAVING COUNT(DISTINCT d.SalesDocumentId) > 1']]]],
  },
  {
    intentId: 'lakeside_days_between_purchases_q1_2026',
    category: 'named_entity',
    difficulty: 'hard',
    failure_class: 'time_window',
    tags: ['customer', 'filter_customer', 'window_function', 'date_arithmetic', 'quarter'],
    phrasings: [
      'For Lakeside Wholesale, list each date in Q1 2026 on which it bought from us, with the number of days since its previous purchase date.',
      "Lakeside Wholesale's Q1 2026 purchase dates and the gap in days to the purchase date before each.",
    ],
    sql: s(`SELECT x.purchase_date, DATEDIFF(x.purchase_date, x.previous_date) AS days_since_previous FROM (
      SELECT t.purchase_date, LAG(t.purchase_date) OVER (ORDER BY t.purchase_date) AS previous_date FROM (
        SELECT DISTINCT d.DocumentDate AS purchase_date FROM SalesDocument d ${CJ} WHERE ${NC} AND c.CustomerName = 'Lakeside Wholesale') t) x
      WHERE ${win('2026-01-01', '2026-04-01', 'x.purchase_date')} ORDER BY x.purchase_date ASC`),
    comparison: { mode: 'rowset' },
    notes:
      "One row per purchase date (several documents on one day are one purchase date). The previous purchase date may fall before Q1 2026 (the window is applied after LAG); the first purchase date ever has no previous one (NULL).",
    negative: [
      ['cancel'],
      ['rep', 'filter', 'customer filter dropped (previous purchase date of any customer)', [[" AND c.CustomerName = 'Lakeside Wholesale'", '']]],
      ['start', 'x.purchase_date'],
      ['end', 'x.purchase_date'],
    ],
    heldout: [
      [
        'sql',
        'time_window',
        'the window applied before LAG, so the first Q1 purchase date gets no previous date',
        `SELECT x.purchase_date, DATEDIFF(x.purchase_date, x.previous_date) AS days_since_previous FROM (SELECT t.purchase_date, LAG(t.purchase_date) OVER (ORDER BY t.purchase_date) AS previous_date FROM (SELECT DISTINCT d.DocumentDate AS purchase_date FROM SalesDocument d ${CJ} WHERE ${NC} AND c.CustomerName = 'Lakeside Wholesale' AND ${Q1_2026}) t) x ORDER BY x.purchase_date ASC`,
      ],
      [
        'sql',
        'grain',
        'one row per document instead of per purchase date (same-day documents give 0-day gaps)',
        `SELECT x.purchase_date, DATEDIFF(x.purchase_date, x.previous_date) AS days_since_previous FROM (SELECT d.DocumentDate AS purchase_date, LAG(d.DocumentDate) OVER (ORDER BY d.DocumentDate, d.DocumentNo) AS previous_date FROM SalesDocument d ${CJ} WHERE ${NC} AND c.CustomerName = 'Lakeside Wholesale') x WHERE ${win('2026-01-01', '2026-04-01', 'x.purchase_date')} ORDER BY x.purchase_date ASC`,
      ],
    ],
  },
  {
    intentId: 'customers_over_2600_mar_2026',
    category: 'standard',
    difficulty: 'medium',
    failure_class: 'entity_filter',
    tags: ['net_sales', 'customer', 'threshold', 'single_month'],
    phrasings: ['Which customers spent more than 2,600 net of tax with us in March 2026, and how much did each spend?', 'Customers above 2600 in net takings for March 2026, with their totals.'],
    sql: `SELECT c.CustomerName, ROUND(${NET}, 2) AS total_net_amount FROM SalesDocument d ${CJ} WHERE ${NC} AND ${MAR_2026} GROUP BY c.CustomerId, c.CustomerName HAVING ${NET} > 2600 ORDER BY ${NET} DESC, c.CustomerName ASC`,
    comparison: { mode: 'rowset', decimals: 2 },
    notes: 'Customers whose non-canceled March 2026 net amount exceeds 2,600, with that amount; the two customers named Summit Grocers are separate customers.',
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['end'],
      ['month_only', '2026-03'],
      ['metric', 'd.NetAmount', 'd.GrossAmount', 'gross instead of net'],
      ['group_by_name'],
    ],
    not_emitted: [equivalentHere('filter', 'at least 2,600 (>=) instead of more than 2,600', 'no customer has exactly 2,600 in March 2026 on any fixture')],
  },
  {
    intentId: 'dormant_account_monthly_2026',
    category: 'named_entity',
    difficulty: 'medium',
    failure_class: 'entity_filter',
    tags: ['net_sales', 'customer', 'filter_customer', 'inactive', 'time_series', 'year'],
    phrasings: ['Did Dormant Demo Account buy anything in 2026? Show its net takings per month.', 'Monthly 2026 turnover for the inactive customer Dormant Demo Account.'],
    series: (label) =>
      `SELECT ${label('d.DocumentDate')} AS month, ROUND(${NET}, 2) AS total_net_amount FROM SalesDocument d ${CJ} WHERE ${NC} AND c.CustomerName = 'Dormant Demo Account' AND ${Y2026} GROUP BY ${label('d.DocumentDate')} ORDER BY month ASC`,
    seriesLabels: ONE_YEAR_LABELS,
    comparison: { mode: 'rowset', decimals: 2 },
    notes: `Months with a non-canceled document only (an empty result is the answer where it bought nothing). ${SERIES_NOTE}`,
    negative: [
      ['cancel'],
      ['date_col'],
      ['rep', 'filter', 'active customers only (the inactive customer drops out)', [["c.CustomerName = 'Dormant Demo Account'", "c.CustomerName = 'Dormant Demo Account' AND c.IsActive = 1"]]],
      ['rep', 'group_by', 'the month dropped from GROUP BY: one row for the whole year under an arbitrary month label', [[" GROUP BY DATE_FORMAT(d.DocumentDate, '%Y-%m')", '']]],
    ],
    not_emitted: [
      fixtureLimit('date_boundary', BOUNDARY_NOTES.start, 'Dormant Demo Account has no document dated 2026-01-01'),
      fixtureLimit('date_boundary', BOUNDARY_NOTES.end, NO_2027),
    ],
  },
  {
    intentId: 'valley_corner_units_by_product_q1_2026',
    category: 'named_entity',
    difficulty: 'medium',
    failure_class: 'entity_filter',
    tags: ['quantity', 'product', 'filter_customer', 'quarter'],
    phrasings: ['What did Valley Corner Shop buy in Q1 2026? Units per product, please.', 'Valley Corner Shop — Q1 2026 units by item.'],
    sql: `SELECT p.ProductName, ROUND(${QTY}, 3) AS total_qty FROM ${LINES} ${PJ} ${CJ} WHERE ${NC} AND c.CustomerName = 'Valley Corner Shop' AND ${Q1_2026} GROUP BY p.ProductId, p.ProductName ORDER BY total_qty DESC, p.ProductName ASC`,
    comparison: { mode: 'rowset', decimals: 3 },
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['rep', 'filter', 'customer filter dropped', [[" AND c.CustomerName = 'Valley Corner Shop'", '']]],
      ['metric', 'l.Quantity', 'l.NetAmount', 'line net amount instead of units'],
    ],
    heldout: [
      ['quarter_only', '2026-01-01', '2026-04-01', 1],
      ['rep', 'stale_snapshot', 'grouped by the stale l.ProductNameSnapshot instead of the product master data', [['SELECT p.ProductName', 'SELECT l.ProductNameSnapshot'], ['GROUP BY p.ProductId, p.ProductName', 'GROUP BY l.ProductNameSnapshot'], ['DESC, p.ProductName ASC', 'DESC, l.ProductNameSnapshot ASC']]],
    ],
    not_emitted: [
      fixtureLimit('date_boundary', BOUNDARY_NOTES.end, 'Valley Corner Shop has no non-canceled document dated 2026-04-01'),
    ],
  },
  {
    intentId: 'customer_c004_gross_jan_2026',
    category: 'named_entity',
    difficulty: 'medium',
    failure_class: 'metric_column_confusion',
    tags: ['gross_amount', 'filter_customer', 'customer_code', 'single_month'],
    phrasings: ["What was customer C-004's gross amount for January 2026?", 'Gross for account code C-004, Jan 2026?'],
    sql: `SELECT ROUND(SUM(COALESCE(d.GrossAmount, 0)), 2) AS total_gross_amount FROM SalesDocument d ${CJ} WHERE ${NC} AND c.CustomerCode = 'C-004' AND ${win('2026-01-01', '2026-02-01')}`,
    comparison: { mode: 'scalar', decimals: 2, null_as_zero: ['total_gross_amount'] },
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['month_only', '2026-01'],
      ['metric', 'd.GrossAmount', 'd.NetAmount', 'net instead of gross'],
      ['metric', 'd.GrossAmount', 'd.BillTotalAmount', 'bill total instead of the gross amount'],
    ],
    not_emitted: [fixtureLimit('date_boundary', BOUNDARY_NOTES.end, 'customer C-004 has no document dated 2026-02-01 on any fixture')],
  },
  {
    intentId: 'metro_online_documents_by_kind_q1_2026',
    category: 'named_entity',
    difficulty: 'medium',
    failure_class: 'entity_filter',
    tags: ['document_count', 'document_kind', 'filter_customer', 'quarter'],
    phrasings: ['How many documents of each kind did Metro Online Store have in Q1 2026?', 'Metro Online Store, first quarter 2026: count of documents per kind (invoice, order, receipt...).'],
    sql: `SELECT t.DocumentTypeName, COUNT(*) AS document_count FROM SalesDocument d ${TJ} ${CJ} WHERE ${NC} AND c.CustomerName = 'Metro Online Store' AND ${Q1_2026} GROUP BY t.DocumentTypeId, t.DocumentTypeName ORDER BY document_count DESC, t.DocumentTypeName ASC`,
    comparison: { mode: 'rowset' },
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['end'],
      ['fan_out', 'every line counted as a document (joined to SalesDocumentLine)'],
      ['rep', 'filter', 'customer filter dropped', [[" AND c.CustomerName = 'Metro Online Store'", '']]],
    ],
  },
  {
    intentId: 'customers_every_month_q1_2026',
    category: 'standard',
    difficulty: 'hard',
    failure_class: 'distinct_count',
    tags: ['customer', 'retention', 'quarter'],
    phrasings: ['Which customers bought something in every month of Q1 2026?', 'Customers with purchases in each of January, February and March 2026.'],
    sql: `SELECT c.CustomerName FROM SalesDocument d ${CJ} WHERE ${NC} AND ${Q1_2026} GROUP BY c.CustomerId, c.CustomerName HAVING COUNT(DISTINCT MONTH(d.DocumentDate)) = 3 ORDER BY c.CustomerName ASC`,
    comparison: { mode: 'rowset' },
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['end'],
      ['rep', 'filter', 'two of the three months counted as enough', [['COUNT(DISTINCT MONTH(d.DocumentDate)) = 3', 'COUNT(DISTINCT MONTH(d.DocumentDate)) >= 2']]],
    ],
    not_emitted: [
      fixtureLimit('group_by', 'grouped by CustomerName only: the two customers named Summit Grocers are merged', 'the two Summit Grocers never split the three months between them'),
    ],
  },

  // ---- time series, comparisons, calendars ----
  {
    intentId: 'cumulative_turnover_2026',
    category: 'standard',
    difficulty: 'hard',
    failure_class: 'aggregation_shape',
    tags: ['net_sales', 'running_total', 'window_function', 'time_series', 'year'],
    phrasings: ['Running total of net takings month by month through 2026.', sv('Visa ackumulerad omsättning månad för månad under 2026.')],
    series: (label) =>
      `WITH m AS (SELECT DATE_FORMAT(d.DocumentDate, '%Y-%m') AS ym, MIN(d.DocumentDate) AS first_day, ${NET} AS net FROM SalesDocument d WHERE ${NC} AND ${Y2026} GROUP BY DATE_FORMAT(d.DocumentDate, '%Y-%m')) SELECT ${label === MONTH_LABELS.ym ? 'm.ym' : label('m.first_day')} AS month, ROUND(SUM(m.net) OVER (ORDER BY m.ym), 2) AS running_total FROM m ORDER BY m.ym ASC`,
    seriesLabels: ONE_YEAR_LABELS,
    comparison: { mode: 'rowset', decimals: 2 },
    notes: `The running total starts at 1 January 2026 and is listed for every month with sales. ${SERIES_NOTE}`,
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['rep', 'aggregation_shape', 'monthly totals instead of the running total', [['SUM(m.net) OVER (ORDER BY m.ym)', 'm.net']]],
    ],
    heldout: [
      [
        'sql',
        'time_window',
        'running total carried over from before 2026',
        `WITH m AS (SELECT DATE_FORMAT(d.DocumentDate, '%Y-%m') AS ym, ${NET} AS net FROM SalesDocument d WHERE ${NC} GROUP BY DATE_FORMAT(d.DocumentDate, '%Y-%m')), r AS (SELECT m.ym, SUM(m.net) OVER (ORDER BY m.ym) AS running_total FROM m) SELECT r.ym AS month, ROUND(r.running_total, 2) AS running_total FROM r WHERE r.ym >= '2026-01' ORDER BY r.ym ASC`,
      ],
    ],
    not_emitted: [
      fixtureLimit('date_boundary', BOUNDARY_NOTES.end, NO_2027),
    ],
  },
  {
    intentId: 'mom_change_dec_2025_apr_2026',
    category: 'standard',
    difficulty: 'hard',
    failure_class: 'aggregation_shape',
    tags: ['net_sales', 'growth', 'window_function', 'time_series', 'date_range'],
    phrasings: [
      'For each month from December 2025 to April 2026, show turnover and the percentage change from the month before (label months YYYY-MM).',
      'MoM % change in net takings, Dec 2025 to Apr 2026, months as YYYY-MM.',
    ],
    sql: s(`WITH m AS (SELECT DATE_FORMAT(d.DocumentDate, '%Y-%m') AS month, ${NET} AS net FROM SalesDocument d WHERE ${NC} AND ${win('2025-11-01', '2026-05-01')} GROUP BY DATE_FORMAT(d.DocumentDate, '%Y-%m')),
      g AS (SELECT m.month, m.net, LAG(m.net) OVER (ORDER BY m.month) AS previous_net FROM m)
      SELECT g.month, ROUND(g.net, 2) AS total_net_amount, ROUND(100 * (g.net - g.previous_net) / g.previous_net, 2) AS pct_change FROM g WHERE g.month >= '2025-12' ORDER BY g.month ASC`),
    comparison: { mode: 'rowset', decimals: 2, tolerance: 0.01 },
    notes: "December's change needs November 2025, so the window starts a month earlier; a month whose previous month has no sales has no change (NULL). Months labelled 'YYYY-MM' as asked.",
    negative: [
      ['cancel'],
      ['date_col'],
      ['end'],
      ['rep', 'ratio', 'change as a fraction instead of a percentage', [['ROUND(100 * (g.net', 'ROUND((g.net']]],
    ],
    heldout: [
      ['rep', 'time_window', 'the window starts in December, so December has no previous month', [["d.DocumentDate >= '2025-11-01'", "d.DocumentDate >= '2025-12-01'"]]],
      ['rep', 'ratio', 'change divided by the current month instead of the previous one', [['/ g.previous_net', '/ g.net']]],
    ],
  },
  {
    intentId: 'weekday_turnover_q1_2026',
    category: 'standard',
    difficulty: 'medium',
    failure_class: 'aggregation_shape',
    tags: ['net_sales', 'weekday', 'quarter'],
    phrasings: [
      "Which day of the week brings in the most turnover? Use Q1 2026 and show every weekday's total, by name.",
      sv('Vilken veckodag drar in mest omsättning? Visa summan per veckodag (namn) för Q1 2026.'),
    ],
    sql: `SELECT DAYNAME(d.DocumentDate) AS weekday, ROUND(${NET}, 2) AS total_net_amount FROM SalesDocument d WHERE ${NC} AND ${Q1_2026} GROUP BY DAYNAME(d.DocumentDate) ORDER BY total_net_amount DESC, weekday ASC`,
    comparison: { mode: 'rowset', decimals: 2 },
    notes: 'Every weekday with sales, labelled by its English name (DAYNAME).',
    negative: [['cancel'], ['date_col'], ['start'], ['end'], ['metric', 'd.NetAmount', 'd.GrossAmount', 'gross instead of net'], ['fan_out']],
    heldout: [['quarter_only', '2026-01-01', '2026-04-01', 1]],
    positive: [['rep', "the weekday name through DATE_FORMAT(.., '%W')", [['DAYNAME(d.DocumentDate)', "DATE_FORMAT(d.DocumentDate, '%W')"]]]],
  },
  {
    intentId: 'ytd_vs_prior_ytd_asof_2026_03_15',
    category: 'ambiguous',
    difficulty: 'hard',
    failure_class: 'relative_date',
    tags: ['net_sales', 'as_of', 'year_to_date', 'pivot'],
    phrasings: [
      "As of 15 March 2026, how does year-to-date turnover compare with the same period last year? One row, this year's figure first.",
      "YTD net takings vs prior-year YTD at 2026-03-15 (this year's figure first).",
    ],
    sql: s(`SELECT ROUND(SUM(CASE WHEN ${win('2026-01-01', '2026-03-16')} THEN COALESCE(d.NetAmount, 0) ELSE 0 END), 2) AS ytd_2026,
      ROUND(SUM(CASE WHEN ${win('2025-01-01', '2025-03-16')} THEN COALESCE(d.NetAmount, 0) ELSE 0 END), 2) AS ytd_2025 FROM SalesDocument d WHERE ${NC}`),
    alternatives: (sql) => [applyPairs(sql, [["'2026-03-16'", "'2026-03-15'"], ["'2025-03-16'", "'2025-03-15'"]])],
    comparison: { mode: 'rowset', decimals: 2, column_order: ['ytd_2026', 'ytd_2025'], null_as_zero: ['ytd_2026', 'ytd_2025'] },
    notes: 'Two readings of year-to-date as of 2026-03-15 are accepted: through the as-of date (the gold) and through the day before (alternative_expected_sql), with the same cut in 2025.',
    negative: [
      ['cancel'],
      ['date_col'],
      ['rep', 'time_window', "last year's whole first quarter instead of the same period", [["d.DocumentDate < '2025-03-16'", "d.DocumentDate < '2025-04-01'"]]],
      ['rep', 'shape', 'the two columns swapped', [['AS ytd_2026, ', 'AS ytd_2025_x, '], ['AS ytd_2025 ', 'AS ytd_2026 '], ['ytd_2025_x', 'ytd_2025']]],
    ],
  },
  {
    intentId: 'store_quarterly_turnover_q1_2025_q1_2026',
    category: 'standard',
    difficulty: 'hard',
    failure_class: 'time_window',
    tags: ['net_sales', 'store_location', 'quarter', 'time_series'],
    phrasings: ['Turnover per store for every quarter from Q1 2025 through Q1 2026, with the year and the quarter number as separate columns.'],
    sql: `SELECT s.LocationName, YEAR(d.DocumentDate) AS sales_year, QUARTER(d.DocumentDate) AS sales_quarter, ROUND(${NET}, 2) AS total_net_amount FROM SalesDocument d ${SJ} WHERE ${NC} AND ${win('2025-01-01', '2026-04-01')} GROUP BY s.StoreLocationId, s.LocationName, YEAR(d.DocumentDate), QUARTER(d.DocumentDate) ORDER BY s.LocationName ASC, sales_year ASC, sales_quarter ASC`,
    comparison: { mode: 'rowset', decimals: 2 },
    notes: 'Quarters with sales only.',
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['end'],
      ['metric', 'd.NetAmount', 'd.GrossAmount', 'gross instead of net'],
      ['rep', 'group_by', 'the year dropped from GROUP BY: Q1 2025 and Q1 2026 merged', [['GROUP BY s.StoreLocationId, s.LocationName, YEAR(d.DocumentDate), QUARTER', 'GROUP BY s.StoreLocationId, s.LocationName, QUARTER']]],
    ],
  },
  {
    intentId: 'best_month_2025',
    category: 'ranking_ties',
    difficulty: 'medium',
    failure_class: 'aggregation_shape',
    tags: ['net_sales', 'ranking', 'year'],
    phrasings: ['Which month of 2025 had the highest turnover, and how much was it?', 'Best month of 2025 by net takings?'],
    series: (label) =>
      `SELECT ${label('d.DocumentDate')} AS month, ROUND(${NET}, 2) AS total_net_amount FROM SalesDocument d WHERE ${NC} AND ${Y2025} GROUP BY ${label('d.DocumentDate')} ORDER BY ${NET} DESC, month ASC LIMIT 1`,
    seriesLabels: ONE_YEAR_LABELS,
    comparison: { mode: 'ranked', value_columns: ['total_net_amount'], order: 'desc', decimals: 2 },
    notes: `The month may be labelled in any of the usual forms. ${SERIES_NOTE}`,
    negative: [
      ['cancel'],
      ['date_col'],
      ['metric', 'd.NetAmount', 'd.GrossAmount', 'gross instead of net'],
      ['rep', 'order_limit', 'lowest month instead of the highest', [[`${NET} DESC`, `${NET} ASC`]]],
      ['rep', 'order_limit', 'LIMIT 1 missing', [[' LIMIT 1', '']]],
    ],
    not_emitted: [
      fixtureLimit('date_boundary', BOUNDARY_NOTES.end, 'a document dated 2026-01-01 forms its own 2026-01 month row, which never tops the best 2025 month'),
    ],
    positive: [
      [
        'sql',
        'monthly totals in a CTE, the top month picked outside',
        `WITH m AS (SELECT DATE_FORMAT(d.DocumentDate, '%Y-%m') AS ym, ${NET} AS net FROM SalesDocument d WHERE ${NC} AND ${Y2025} GROUP BY DATE_FORMAT(d.DocumentDate, '%Y-%m')) SELECT m.ym, ROUND(m.net, 2) AS turnover FROM m ORDER BY m.net DESC, m.ym ASC LIMIT 1`,
      ],
    ],
  },
  {
    intentId: 'busiest_day_mar_2026',
    category: 'ranking_ties',
    difficulty: 'medium',
    failure_class: 'aggregation_shape',
    tags: ['document_count', 'day', 'ranking', 'single_month'],
    phrasings: ['What was our busiest day in March 2026 by number of documents, and how many were there? If days tie, give the earliest.', 'Peak day for document volume in March 2026 (earliest if tied).'],
    sql: `SELECT d.DocumentDate, COUNT(*) AS document_count FROM SalesDocument d WHERE ${NC} AND ${MAR_2026} GROUP BY d.DocumentDate ORDER BY COUNT(*) DESC, d.DocumentDate ASC LIMIT 1`,
    comparison: { mode: 'ranked', value_columns: ['document_count'], order: 'desc' },
    notes: 'Ties are broken by the earliest date; under the comparison spec a day tied with it at the top also passes.',
    negative: [
      ['cancel'],
      ['date_col'],
      ['fan_out', 'every line counted as a document (joined to SalesDocumentLine)'],
      ['rep', 'order_limit', 'quietest day instead of the busiest', [['COUNT(*) DESC', 'COUNT(*) ASC']]],
      ['rep', 'order_limit', 'LIMIT 1 missing', [[' LIMIT 1', '']]],
    ],
    not_emitted: [
      fixtureLimit('date_filter', 'MONTH() without YEAR(): the same month of every year is included', 'no March 2025 day has as many documents as the busiest March 2026 day'),
    ],
  },
  {
    intentId: 'store_mar_vs_apr_2026',
    category: 'standard',
    difficulty: 'hard',
    failure_class: 'aggregation_shape',
    tags: ['net_sales', 'store_location', 'pivot', 'single_month'],
    phrasings: ["Put each store's March 2026 and April 2026 turnover side by side, March first.", bi('Store turnover mars vs april 2026 i två kolumner, mars först.')],
    sql: s(`SELECT s.LocationName, ROUND(SUM(CASE WHEN ${MAR_2026} THEN COALESCE(d.NetAmount, 0) ELSE 0 END), 2) AS mar_2026,
      ROUND(SUM(CASE WHEN ${APR_2026} THEN COALESCE(d.NetAmount, 0) ELSE 0 END), 2) AS apr_2026
      FROM SalesDocument d ${SJ} WHERE ${NC} AND ${win('2026-03-01', '2026-05-01')} GROUP BY s.StoreLocationId, s.LocationName ORDER BY s.LocationName ASC`),
    comparison: { mode: 'rowset', compare_columns: ['LocationName', 'mar_2026', 'apr_2026'], decimals: 2, column_order: ['mar_2026', 'apr_2026'], null_as_zero: ['mar_2026', 'apr_2026'] },
    notes: 'column_order keeps March first unless the columns are named like the gold columns; null_as_zero accepts NULL for a month without sales.',
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['end'],
      ['metric', 'd.NetAmount', 'd.GrossAmount', 'gross instead of net'],
      ['rep', 'shape', 'the two month columns swapped', [['AS mar_2026,', 'AS apr_2026_x,'], ['AS apr_2026 ', 'AS mar_2026 '], ['apr_2026_x', 'apr_2026']]],
    ],
  },
  {
    intentId: 'category_h1_vs_h2_2025',
    category: 'standard',
    difficulty: 'hard',
    failure_class: 'aggregation_shape',
    tags: ['line_net_sales', 'product_category', 'pivot', 'year'],
    phrasings: ['Compare first-half and second-half 2025 net takings for each category, first half first.', 'H1 vs H2 2025 turnover by category (two columns, H1 first).'],
    sql: s(`SELECT pc.CategoryName, ROUND(SUM(CASE WHEN ${win('2025-01-01', '2025-07-01')} THEN COALESCE(l.NetAmount, 0) ELSE 0 END), 2) AS h1_2025,
      ROUND(SUM(CASE WHEN ${win('2025-07-01', '2026-01-01')} THEN COALESCE(l.NetAmount, 0) ELSE 0 END), 2) AS h2_2025
      FROM ${LINES} ${PJ} ${PCJ} WHERE ${NC} AND ${Y2025} GROUP BY pc.ProductCategoryId, pc.CategoryName ORDER BY pc.CategoryName ASC`),
    comparison: { mode: 'rowset', compare_columns: ['CategoryName', 'h1_2025', 'h2_2025'], decimals: 2, tolerance: 0.01, column_order: ['h1_2025', 'h2_2025'], null_as_zero: ['h1_2025', 'h2_2025'] },
    notes: 'Line net amounts by the product category; column_order keeps H1 first unless the columns are named like the gold columns.',
    negative: [
      ['cancel'],
      ['date_col'],
      ['end'],
      ['rep', 'join_path', "category through the brand's default category instead of Product.ProductCategoryId", [[PCJ, `${BJ} JOIN ProductCategory pc ON b.ProductCategoryId = pc.ProductCategoryId`]]],
      ['rep', 'grain', 'the document net amount summed for every line instead of the line net amount', [['COALESCE(l.NetAmount, 0)', 'COALESCE(d.NetAmount, 0)']]],
      ['rep', 'shape', 'the two half-year columns swapped', [['AS h1_2025,', 'AS h2_2025_x,'], ['AS h2_2025 ', 'AS h1_2025 '], ['h2_2025_x', 'h2_2025']]],
    ],
  },
  {
    intentId: 'customers_up_q1_2026_vs_q4_2025',
    category: 'standard',
    difficulty: 'hard',
    failure_class: 'time_window',
    tags: ['net_sales', 'customer', 'growth', 'quarter'],
    phrasings: ['Which customers spent more with us in Q1 2026 than in Q4 2025?', 'Customers whose net takings grew from Q4 2025 to Q1 2026.'],
    sql: s(`SELECT c.CustomerName, ROUND(SUM(CASE WHEN ${win('2025-10-01', '2026-01-01')} THEN COALESCE(d.NetAmount, 0) ELSE 0 END), 2) AS q4_2025,
      ROUND(SUM(CASE WHEN ${Q1_2026} THEN COALESCE(d.NetAmount, 0) ELSE 0 END), 2) AS q1_2026
      FROM SalesDocument d ${CJ} WHERE ${NC} AND ${win('2025-10-01', '2026-04-01')} GROUP BY c.CustomerId, c.CustomerName
      HAVING SUM(CASE WHEN ${Q1_2026} THEN COALESCE(d.NetAmount, 0) ELSE 0 END) > SUM(CASE WHEN ${win('2025-10-01', '2026-01-01')} THEN COALESCE(d.NetAmount, 0) ELSE 0 END)
      ORDER BY c.CustomerName ASC`),
    comparison: { mode: 'rowset', compare_columns: ['CustomerName'] },
    notes: 'Compared on the customer names only (the two quarter totals may be shown or not). A customer without Q4 2025 sales that bought in Q1 2026 spent more.',
    negative: [
      ['cancel'],
      ['date_col'],
      [
        'rep',
        'filter',
        'customers that spent less instead of more',
        [[`ELSE 0 END) > SUM(CASE WHEN ${win('2025-10-01', '2026-01-01')}`, `ELSE 0 END) < SUM(CASE WHEN ${win('2025-10-01', '2026-01-01')}`]],
      ],
      ['group_by_name'],
    ],
    not_emitted: [
      fixtureLimit('date_boundary', BOUNDARY_NOTES.end, 'the documents on the day after each quarter do not change which customers grew'),
      fixtureLimit('date_boundary', BOUNDARY_NOTES.start, 'the documents on the first day of each quarter do not change which customers grew'),
    ],
  },
  {
    intentId: 'value_bands_mar_2026',
    category: 'standard',
    difficulty: 'hard',
    failure_class: 'aggregation_shape',
    tags: ['document_count', 'value_band', 'pivot', 'single_month'],
    phrasings: ['How many March 2026 documents fell into each net value band — under 500, 500 up to 1,000, and 1,000 or more? One row.'],
    sql: s(`SELECT SUM(CASE WHEN COALESCE(d.NetAmount, 0) < 500 THEN 1 ELSE 0 END) AS under_500,
      SUM(CASE WHEN COALESCE(d.NetAmount, 0) >= 500 AND COALESCE(d.NetAmount, 0) < 1000 THEN 1 ELSE 0 END) AS from_500_to_1000,
      SUM(CASE WHEN COALESCE(d.NetAmount, 0) >= 1000 THEN 1 ELSE 0 END) AS from_1000
      FROM SalesDocument d WHERE ${NC} AND ${MAR_2026}`),
    comparison: { mode: 'rowset', column_order: ['under_500', 'from_500_to_1000', 'from_1000'], null_as_zero: ['under_500', 'from_500_to_1000', 'from_1000'] },
    notes: 'Bands by document net amount: [0, 500), [500, 1000), [1000, ...). One row, bands in the asked order.',
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['end'],
      ['month_only', '2026-03'],
      ['metric', 'd.NetAmount', 'd.GrossAmount', 'gross instead of net'],
      ['fan_out', 'every line counted as a document (joined to SalesDocumentLine)'],
    ],
    heldout: [['rep', 'date_boundary', 'a document of exactly 500 or 1,000 put in the lower band', [['< 500 THEN', '<= 500 THEN'], ['>= 500 AND COALESCE(d.NetAmount, 0) < 1000', '> 500 AND COALESCE(d.NetAmount, 0) <= 1000'], ['>= 1000 THEN', '> 1000 THEN']]]],
  },
  {
    intentId: 'last_week_asof_2026_04_08',
    category: 'relative_date',
    difficulty: 'medium',
    failure_class: 'relative_date',
    tags: ['net_sales', 'as_of', 'week'],
    phrasings: ['Today is Wednesday 8 April 2026. What were our net takings last week, Monday to Sunday?', 'As of 2026-04-08, turnover for the previous Monday-to-Sunday week?'],
    sql: `SELECT ROUND(${NET}, 2) AS total_net_amount FROM SalesDocument d WHERE ${NC} AND ${win('2026-03-30', '2026-04-06')}`,
    comparison: { mode: 'scalar', decimals: 2, null_as_zero: ['total_net_amount'] },
    notes: 'Last week as of Wednesday 2026-04-08 is Monday 30 March to Sunday 5 April 2026.',
    negative: [
      ['cancel'],
      ['end'],
      ['rep', 'time_window', 'the last seven days instead of last calendar week', [[win('2026-03-30', '2026-04-06'), win('2026-04-01', '2026-04-08')]]],
      ['rep', 'time_window', 'the current week so far instead of last week', [[win('2026-03-30', '2026-04-06'), win('2026-04-06', '2026-04-09')]]],
      ['metric', 'd.NetAmount', 'd.GrossAmount', 'gross instead of net'],
    ],
    not_emitted: [
      fixtureLimit('date_boundary', BOUNDARY_NOTES.start, 'the only document dated Monday 30 March 2026 is canceled'),
      fixtureLimit('date_col', 'PostingDate instead of DocumentDate', 'no document of that week is posted outside it, and none from outside is posted into it'),
    ],
    positive: [['between', '2026-03-30', '2026-04-06']],
  },
  {
    intentId: 'documents_last_7_days_asof_2026_04_07',
    category: 'relative_date',
    difficulty: 'medium',
    failure_class: 'relative_date',
    tags: ['document_count', 'as_of'],
    phrasings: ['As of 2026-04-07, how many documents have we raised in the last 7 days, today included?', 'Documents raised in the 7 days up to and including 7 April 2026?'],
    sql: `SELECT COUNT(*) AS document_count FROM SalesDocument d WHERE ${NC} AND ${win('2026-04-01', '2026-04-08')}`,
    comparison: { mode: 'scalar' },
    notes: 'The last 7 days including the as-of date: 1 to 7 April 2026.',
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['fan_out', 'every line counted as a document (joined to SalesDocumentLine)'],
      ['rep', 'time_window', 'the 7 days before the as-of date (today left out)', [[win('2026-04-01', '2026-04-08'), win('2026-03-31', '2026-04-07')]]],
    ],
    not_emitted: [fixtureLimit('date_boundary', BOUNDARY_NOTES.end, 'no fixture has a document dated 2026-04-08')],
  },

  // ---- stores, campaigns, document kinds ----
  {
    intentId: 'store_distinct_products_mar_2026',
    category: 'new_vocabulary',
    difficulty: 'medium',
    failure_class: 'distinct_count',
    tags: ['product', 'store_location', 'distinct_count', 'single_month'],
    phrasings: ['How many different products did each store sell in March 2026?', 'Range breadth per outlet in March 2026 — number of distinct SKUs sold.'],
    sql: `SELECT s.LocationName, COUNT(DISTINCT l.ProductId) AS product_count FROM ${LINES} ${SJ} WHERE ${NC} AND ${MAR_2026} GROUP BY s.StoreLocationId, s.LocationName ORDER BY product_count DESC, s.LocationName ASC`,
    comparison: { mode: 'rowset' },
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['end'],
      ['month_only', '2026-03'],
      ['rep', 'count', 'lines counted instead of distinct products', [['COUNT(DISTINCT l.ProductId)', 'COUNT(*)']]],
    ],
  },
  {
    intentId: 'top_customer_per_store_q1_2026',
    category: 'ranking_ties',
    difficulty: 'hard',
    failure_class: 'aggregation_shape',
    tags: ['net_sales', 'customer', 'store_location', 'window_function', 'quarter'],
    phrasings: ['Who was the top customer at each store in Q1 2026 by turnover? Break ties alphabetically.', 'Biggest client per outlet for Q1 2026, by net takings (alphabetical on ties).'],
    sql: s(`SELECT x.LocationName, x.CustomerName, x.total_net_amount FROM (
      SELECT s.LocationName, c.CustomerName, ROUND(${NET}, 2) AS total_net_amount,
        ROW_NUMBER() OVER (PARTITION BY s.StoreLocationId ORDER BY ${NET} DESC, c.CustomerName ASC, c.CustomerId ASC) AS rn
      FROM SalesDocument d ${SJ} ${CJ} WHERE ${NC} AND ${Q1_2026}
      GROUP BY s.StoreLocationId, s.LocationName, c.CustomerId, c.CustomerName) x WHERE x.rn = 1 ORDER BY x.LocationName ASC`),
    comparison: { mode: 'rowset', decimals: 2 },
    negative: [
      ['cancel'],
      ['start'],
      ['end'],
      ['metric', 'd.NetAmount', 'd.GrossAmount', 'gross instead of net'],
      ['rep', 'group_by', 'grouped by CustomerName only: the two customers named Summit Grocers are merged', [['GROUP BY s.StoreLocationId, s.LocationName, c.CustomerId, c.CustomerName', 'GROUP BY s.StoreLocationId, s.LocationName, c.CustomerName'], [', c.CustomerId ASC', '']]],
    ],
    heldout: [['quarter_only', '2026-01-01', '2026-04-01', 1]],
    not_emitted: [
      fixtureLimit('date_col', 'PostingDate instead of DocumentDate', "the documents posted in another quarter do not change any store's top customer"),
    ],
  },
  {
    intentId: 'second_store_feb_2026',
    category: 'ranking_ties',
    difficulty: 'medium',
    failure_class: 'aggregation_shape',
    tags: ['net_sales', 'store_location', 'ranking', 'single_month'],
    phrasings: ['Which store came second by turnover in February 2026? If two tie, alphabetical order decides.', 'Runner-up outlet by net takings, Feb 2026.'],
    sql: `SELECT s.LocationName, ROUND(${NET}, 2) AS total_net_amount FROM SalesDocument d ${SJ} WHERE ${NC} AND ${FEB_2026} GROUP BY s.StoreLocationId, s.LocationName ORDER BY ${NET} DESC, s.LocationName ASC LIMIT 1 OFFSET 1`,
    comparison: { mode: 'ranked', value_columns: ['total_net_amount'], order: 'desc', decimals: 2 },
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['end'],
      ['month_only', '2026-02'],
      ['rep', 'order_limit', 'the top store instead of the runner-up', [[' OFFSET 1', '']]],
    ],
    not_emitted: [
      equivalentHere('order_limit', 'second from the bottom instead of second from the top', 'with three stores the second from the top is the second from the bottom (no store ties in February 2026)'),
    ],
  },
  {
    intentId: 'min_max_document_by_store_mar_2026',
    category: 'standard',
    difficulty: 'medium',
    failure_class: 'grain_confusion',
    tags: ['net_sales', 'store_location', 'document', 'single_month'],
    phrasings: ['Smallest and largest document by net value at each store in March 2026.', 'Per outlet, the lowest and highest net document value for March 2026.'],
    sql: `SELECT s.LocationName, ROUND(MIN(COALESCE(d.NetAmount, 0)), 2) AS smallest_document, ROUND(MAX(COALESCE(d.NetAmount, 0)), 2) AS largest_document FROM SalesDocument d ${SJ} WHERE ${NC} AND ${MAR_2026} GROUP BY s.StoreLocationId, s.LocationName ORDER BY s.LocationName ASC`,
    comparison: { mode: 'rowset', decimals: 2, column_order: ['smallest_document', 'largest_document'] },
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['end'],
      ['month_only', '2026-03'],
      ['metric', 'd.NetAmount', 'd.GrossAmount', 'gross instead of net'],
      [
        'sql',
        'grain',
        'smallest and largest line instead of document',
        `SELECT s.LocationName, ROUND(MIN(COALESCE(l.NetAmount, 0)), 2) AS smallest_document, ROUND(MAX(COALESCE(l.NetAmount, 0)), 2) AS largest_document FROM ${LINES} ${SJ} WHERE ${NC} AND ${MAR_2026} GROUP BY s.StoreLocationId, s.LocationName ORDER BY s.LocationName ASC`,
      ],
    ],
  },
  {
    intentId: 'south_store_receipt_avg_2026',
    category: 'named_entity',
    difficulty: 'medium',
    failure_class: 'entity_filter',
    tags: ['average_order_value', 'filter_store_location', 'filter_document_kind', 'year'],
    phrasings: ['What is the average net ticket for Store Receipts at the South Store in 2026?', 'South Store, 2026: average net value of a Store Receipt.'],
    sql: `SELECT ROUND(AVG(COALESCE(d.NetAmount, 0)), 2) AS avg_net_value FROM SalesDocument d ${SJ} ${TJ} WHERE ${NC} AND s.LocationName = 'South Store' AND t.DocumentTypeName = 'Store Receipt' AND ${Y2026}`,
    comparison: { mode: 'scalar', decimals: 2, tolerance: 0.01 },
    negative: [
      ['cancel'],
      ['rep', 'filter', 'document kind filter dropped', [[" AND t.DocumentTypeName = 'Store Receipt'", '']]],
      ['rep', 'filter', 'store filter dropped', [[" AND s.LocationName = 'South Store'", '']]],
      ['metric', 'd.NetAmount', 'd.GrossAmount', 'gross instead of net'],
    ],
    not_emitted: [
      fixtureLimit('date_boundary', BOUNDARY_NOTES.start, 'no South Store receipt is dated 2026-01-01 with an amount that moves the average'),
      fixtureLimit('date_col', 'PostingDate instead of DocumentDate', 'selecting by posting date moves no South Store receipt in or out of 2026'),
      fixtureLimit('date_boundary', BOUNDARY_NOTES.end, NO_2027),
    ],
  },
  {
    intentId: 'campaign_units_by_store_q1_2026',
    category: 'standard',
    difficulty: 'hard',
    failure_class: 'campaign_join_path',
    tags: ['quantity', 'campaign', 'store_location', 'quarter'],
    phrasings: ['Units per promotion and store for Q1 2026.', 'How many units did each campaign shift through each outlet in Q1 2026?'],
    sql: `SELECT cp.CampaignName, s.LocationName, ROUND(${QTY}, 3) AS total_qty FROM ${LINES} ${PJ} ${CPJ} ${SJ} WHERE ${NC} AND ${Q1_2026} GROUP BY cp.CampaignId, cp.CampaignName, s.StoreLocationId, s.LocationName ORDER BY cp.CampaignName ASC, s.LocationName ASC`,
    comparison: { mode: 'rowset', decimals: 3 },
    notes: "The campaign of a unit is its product's campaign (Product.CampaignId), not the document header's.",
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['end'],
      ['rep', 'join_path', "campaign through the document header's CampaignId instead of the product's campaign", [[CPJ, 'JOIN Campaign cp ON d.CampaignId = cp.CampaignId']]],
      ['rep', 'group_by', 'the store key dropped from GROUP BY (its name still selected): one arbitrary store per campaign', [[', s.StoreLocationId, s.LocationName ORDER BY', ' ORDER BY']]],
      ['metric', 'l.Quantity', 'l.NetAmount', 'line net amount instead of units'],
    ],
    heldout: [['quarter_only', '2026-01-01', '2026-04-01', 1]],
  },
  {
    intentId: 'spring_essentials_buyers_2026',
    category: 'named_entity',
    difficulty: 'hard',
    failure_class: 'campaign_join_path',
    tags: ['line_net_sales', 'customer', 'filter_campaign', 'year'],
    phrasings: ['Which customers bought Spring Essentials products in 2026, and how much did they spend on them?', '2026 buyers of Spring Essentials items and their net spend on those items.'],
    sql: `SELECT c.CustomerName, ROUND(${LNET}, 2) AS total_net_amount FROM ${LINES} ${PJ} ${CPJ} ${CJ} WHERE ${NC} AND cp.CampaignName = 'Spring Essentials' AND ${Y2026} GROUP BY c.CustomerId, c.CustomerName ORDER BY total_net_amount DESC, c.CustomerName ASC`,
    comparison: { mode: 'rowset', decimals: 2, tolerance: 0.01 },
    notes: "Line net amounts of the products in the Spring Essentials campaign (Product.CampaignId), not the document header's campaign.",
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['rep', 'join_path', "campaign through the document header's CampaignId instead of the product's campaign", [[CPJ, 'JOIN Campaign cp ON d.CampaignId = cp.CampaignId']]],
      ['group_by_name'],
      ['rep', 'grain', 'the document net amount summed for every line instead of the line net amount', [[LNET, NET]]],
      ['metric', 'l.NetAmount', 'l.TotalAmount', 'line TotalAmount (before adjustments) instead of line NetAmount'],
    ],
    not_emitted: [
      fixtureLimit('date_boundary', BOUNDARY_NOTES.end, NO_2027),
    ],
  },
  {
    intentId: 'credit_note_value_monthly_2026',
    category: 'new_vocabulary',
    difficulty: 'medium',
    failure_class: 'vocabulary',
    tags: ['net_sales', 'document_kind', 'filter_document_kind', 'time_series', 'year'],
    phrasings: [
      { q: 'Monthly net value of credit notes issued in 2026.', knownRejection: 'METRIC_COLUMN' },
      { q: 'Credit notes in 2026: net amount per month.', knownRejection: 'METRIC_COLUMN' },
    ],
    series: (label) =>
      `SELECT ${label('d.DocumentDate')} AS month, ROUND(${NET}, 2) AS total_net_amount FROM SalesDocument d ${TJ} WHERE ${NC} AND t.DocumentTypeName = 'Credit Memo' AND ${Y2026} GROUP BY ${label('d.DocumentDate')} ORDER BY month ASC`,
    seriesLabels: ONE_YEAR_LABELS,
    comparison: { mode: 'rowset', decimals: 2 },
    notes: `Credit notes are the Credit Memo documents. ${SERIES_NOTE} Known validator rejection: the word "credit" makes the credit-amount metric guardrail demand AccountingPosting.CreditAmount, which a document question does not need.`,
    negative: [
      ['cancel'],
      ['date_col'],
      ['rep', 'filter', 'document kind filter dropped', [[" AND t.DocumentTypeName = 'Credit Memo'", '']]],
      ['metric', 'd.NetAmount', 'd.GrossAmount', 'gross instead of net'],
      ['rep', 'group_by', 'the month dropped from GROUP BY: one row for the whole year under an arbitrary month label', [[" GROUP BY DATE_FORMAT(d.DocumentDate, '%Y-%m')", '']]],
    ],
    not_emitted: [
      fixtureLimit('date_boundary', BOUNDARY_NOTES.start, 'no credit note is dated 2026-01-01'),
      fixtureLimit('date_boundary', BOUNDARY_NOTES.end, NO_2027),
    ],
  },
  {
    intentId: 'invoice_vs_receipt_avg_q1_2026',
    category: 'named_entity',
    difficulty: 'medium',
    failure_class: 'ratio_metric',
    tags: ['average_order_value', 'document_kind', 'filter_document_kind', 'quarter'],
    phrasings: ['Compare the average net value of a Sales Invoice with that of a Store Receipt in Q1 2026, one row per kind.', 'Avg net per Sales Invoice vs per Store Receipt, Q1 2026 (a row each).'],
    sql: `SELECT t.DocumentTypeName, ROUND(AVG(COALESCE(d.NetAmount, 0)), 2) AS avg_net_value FROM SalesDocument d ${TJ} WHERE ${NC} AND t.DocumentTypeName IN ('Sales Invoice', 'Store Receipt') AND ${Q1_2026} GROUP BY t.DocumentTypeId, t.DocumentTypeName ORDER BY t.DocumentTypeName ASC`,
    comparison: { mode: 'rowset', decimals: 2, tolerance: 0.01 },
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['end'],
      ['metric', 'd.NetAmount', 'd.GrossAmount', 'gross instead of net'],
      ['fan_out'],
      ['rep', 'ratio', 'the total instead of the average', [['ROUND(AVG(', 'ROUND(SUM(']]],
    ],
  },
  {
    intentId: 'fee_lines_q1_2026',
    category: 'new_vocabulary',
    difficulty: 'medium',
    failure_class: 'grain_confusion',
    tags: ['line_net_sales', 'fee_lines', 'quarter'],
    phrasings: ['How much did we charge in Q1 2026 on lines that carry no product, such as delivery fees?', 'Q1 2026 non-product line charges (delivery fees etc.), net.'],
    sql: `SELECT ROUND(${LNET}, 2) AS fee_net_amount FROM ${LINES} WHERE ${NC} AND l.ProductId IS NULL AND ${Q1_2026}`,
    comparison: { mode: 'scalar', decimals: 2, tolerance: 0.01, null_as_zero: ['fee_net_amount'] },
    notes: 'Lines without a product (NULL ProductId) are the delivery-fee lines; their line net amount.',
    negative: [
      ['date_col'],
      ['rep', 'filter', 'no-product filter dropped (every line)', [[' AND l.ProductId IS NULL', '']]],
    ],
    heldout: [['quarter_only', '2026-01-01', '2026-04-01', 1]],
    not_emitted: [
      fixtureLimit('metric', 'line TotalAmount instead of NetAmount', 'every fee line has TotalAmount equal to NetAmount'),
      fixtureLimit('date_boundary', BOUNDARY_NOTES.end, 'no fee line is dated 2026-04-01'),
      fixtureLimit('date_boundary', BOUNDARY_NOTES.start, 'no fee line is dated 2026-01-01'),
      fixtureLimit('cancel', 'canceled documents not excluded', 'no fee line is on a canceled document'),
    ],
  },
  {
    intentId: 'gross_net_gap_by_kind_q1_2026',
    category: 'standard',
    difficulty: 'medium',
    failure_class: 'metric_column_confusion',
    tags: ['gross_amount', 'net_sales', 'document_kind', 'quarter'],
    phrasings: ['How big was the difference between gross and net amounts for each kind of document in Q1 2026?', 'Gross-to-net gap by document kind, Q1 2026.'],
    sql: `SELECT t.DocumentTypeName, ROUND(SUM(COALESCE(d.GrossAmount, 0) - COALESCE(d.NetAmount, 0)), 2) AS gross_net_gap FROM SalesDocument d ${TJ} WHERE ${NC} AND ${Q1_2026} GROUP BY t.DocumentTypeId, t.DocumentTypeName ORDER BY gross_net_gap DESC, t.DocumentTypeName ASC`,
    comparison: { mode: 'rowset', decimals: 2 },
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['end'],
      ['metric', 'd.NetAmount', 'd.NetPayableAmount', 'payable amount instead of net'],
      ['fan_out'],
    ],
    heldout: [['rep', 'metric', 'net minus gross (sign reversed)', [['SUM(COALESCE(d.GrossAmount, 0) - COALESCE(d.NetAmount, 0))', 'SUM(COALESCE(d.NetAmount, 0) - COALESCE(d.GrossAmount, 0))']]]],
  },
  {
    intentId: 'lines_per_document_by_kind_2026',
    category: 'standard',
    difficulty: 'medium',
    failure_class: 'grain_confusion',
    tags: ['line', 'document_kind', 'basket', 'year'],
    phrasings: ['How many lines does a document of each kind carry on average in 2026?', 'Avg line count per document by kind, 2026.'],
    sql: `SELECT t.DocumentTypeName, ROUND(COUNT(*) / COUNT(DISTINCT d.SalesDocumentId), 2) AS avg_lines_per_document FROM ${LINES} ${TJ} WHERE ${NC} AND ${Y2026} GROUP BY t.DocumentTypeId, t.DocumentTypeName ORDER BY t.DocumentTypeName ASC`,
    comparison: { mode: 'rowset', decimals: 2, tolerance: 0.01 },
    notes: 'Every line counts, delivery-fee lines included; every fixture document has at least one line.',
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['rep', 'count', 'distinct products per kind instead of lines per document', [['COUNT(*) / COUNT(DISTINCT d.SalesDocumentId)', 'COUNT(DISTINCT l.ProductId)']]],
    ],
    not_emitted: [
      fixtureLimit('date_boundary', BOUNDARY_NOTES.end, NO_2027),
    ],
  },

  // ---- named products, brands, customers ----
  {
    intentId: 'herbal_tea_buyers_q1_2026',
    category: 'named_entity',
    difficulty: 'medium',
    failure_class: 'entity_filter',
    tags: ['quantity', 'customer', 'filter_product', 'quarter'],
    phrasings: ['Who bought Herbal Tea Variety Pack in Q1 2026, and how many units each?', 'Herbal Tea Variety Pack buyers in Q1 2026 with their units.'],
    sql: `SELECT c.CustomerName, ROUND(${QTY}, 3) AS total_qty FROM ${LINES} ${PJ} ${CJ} WHERE ${NC} AND p.ProductName = 'Herbal Tea Variety Pack' AND ${Q1_2026} GROUP BY c.CustomerId, c.CustomerName ORDER BY total_qty DESC, c.CustomerName ASC`,
    comparison: { mode: 'rowset', decimals: 3 },
    negative: [
      ['cancel'],
      ['start'],
      ['end'],
      ['group_by_name'],
      ['rep', 'filter', 'product filter dropped', [["p.ProductName = 'Herbal Tea Variety Pack' AND ", '']]],
      ['metric', 'l.Quantity', 'l.NetAmount', 'line net amount instead of units'],
    ],
    heldout: [['rep', 'stale_snapshot', 'filter on the line snapshot l.ProductNameSnapshot instead of the product master data', [["p.ProductName = 'Herbal Tea Variety Pack'", "l.ProductNameSnapshot LIKE '%Herbal Tea%'"]]]],
    not_emitted: [
      fixtureLimit('date_col', 'PostingDate instead of DocumentDate', "selecting by posting date changes no customer's Herbal Tea Variety Pack units"),
    ],
  },
  {
    intentId: 'lime_seltzer_units_by_store_2026',
    category: 'named_entity',
    difficulty: 'medium',
    failure_class: 'entity_resolution',
    tags: ['quantity', 'store_location', 'filter_product', 'year'],
    phrasings: ['Units of Lime Seltzer 8 Pack by store for 2026.', 'Where did the Lime Seltzer 8 Pack sell in 2026? Units per outlet.'],
    sql: `SELECT s.LocationName, ROUND(${QTY}, 3) AS total_qty FROM ${LINES} ${PJ} ${SJ} WHERE ${NC} AND p.ProductName = 'Lime Seltzer 8 Pack' AND ${Y2026} GROUP BY s.StoreLocationId, s.LocationName ORDER BY total_qty DESC, s.LocationName ASC`,
    comparison: { mode: 'rowset', decimals: 3 },
    notes: 'Only the Lime Seltzer 8 Pack: the sparkling waters are tagged seltzer too, but are other products.',
    negative: [
      ['date_col'],
      ['rep', 'filter', "every product tagged 'seltzer' instead of the named one", [["p.ProductName = 'Lime Seltzer 8 Pack'", "p.ProductTags LIKE '%seltzer%'"]]],
      ['metric', 'l.Quantity', 'l.NetAmount', 'line net amount instead of units'],
    ],
    not_emitted: [
      fixtureLimit('date_boundary', BOUNDARY_NOTES.start, 'no Lime Seltzer 8 Pack line is dated 2026-01-01'),
      fixtureLimit('cancel', 'canceled documents not excluded', 'no canceled 2026 document carries Lime Seltzer 8 Pack'),
      fixtureLimit('date_boundary', BOUNDARY_NOTES.end, NO_2027),
    ],
  },
  {
    intentId: 'northstar_by_category_mar_2026',
    category: 'named_entity',
    difficulty: 'hard',
    failure_class: 'wrong_join_path',
    tags: ['line_net_sales', 'brand', 'product_category', 'filter_brand', 'single_month'],
    phrasings: ['Northstar Goods turnover in March 2026, split by category.', "Split Northstar Goods' March 2026 net takings across categories."],
    sql: `SELECT pc.CategoryName, ROUND(${LNET}, 2) AS total_net_amount FROM ${LINES} ${PJ} ${BJ} ${PCJ} WHERE ${NC} AND b.BrandName = 'Northstar Goods' AND ${MAR_2026} GROUP BY pc.ProductCategoryId, pc.CategoryName ORDER BY total_net_amount DESC, pc.CategoryName ASC`,
    comparison: { mode: 'rowset', decimals: 2, tolerance: 0.01 },
    notes: "The category of each product (Product.ProductCategoryId): Northstar Goods sells a Snacks product, while the brand's default category is Beverages.",
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['end'],
      ['month_only', '2026-03'],
      ['rep', 'join_path', "category through the brand's default category instead of Product.ProductCategoryId", [[PCJ, 'JOIN ProductCategory pc ON b.ProductCategoryId = pc.ProductCategoryId']]],
      ['rep', 'join_path', 'brand through the ProductBrand bridge (only some products have a row) instead of Product.BrandId', [[BJ, 'JOIN ProductBrand pb ON pb.ProductId = p.ProductId JOIN Brand b ON pb.BrandId = b.BrandId']]],
      ['rep', 'grain', 'the document net amount summed for every line instead of the line net amount', [[LNET, NET]]],
    ],
    heldout: [['rep', 'stale_snapshot', 'grouped by the stale l.CategoryNameSnapshot instead of the category master data', [[` ${PCJ}`, ''], ['pc.CategoryName', 'l.CategoryNameSnapshot'], ['GROUP BY pc.ProductCategoryId, ', 'GROUP BY ']]]],
  },
  {
    intentId: 'homebase_units_monthly_2025',
    category: 'named_entity',
    difficulty: 'medium',
    failure_class: 'aggregation_shape',
    tags: ['quantity', 'brand', 'filter_brand', 'time_series', 'year'],
    phrasings: ['Monthly units of Homebase Supply products during 2025.', 'Homebase Supply: units per month across 2025.'],
    series: (label) =>
      `SELECT ${label('d.DocumentDate')} AS month, ROUND(${QTY}, 3) AS total_qty FROM ${LINES} ${PJ} ${BJ} WHERE ${NC} AND b.BrandName = 'Homebase Supply' AND ${Y2025} GROUP BY ${label('d.DocumentDate')} ORDER BY month ASC`,
    seriesLabels: ONE_YEAR_LABELS,
    comparison: { mode: 'rowset', decimals: 3 },
    notes: SERIES_NOTE,
    negative: [
      ['cancel'],
      ['date_col'],
      ['end'],
      ['rep', 'filter', 'brand filter dropped', [["b.BrandName = 'Homebase Supply' AND ", '']]],
      ['metric', 'l.Quantity', 'l.NetAmount', 'line net amount instead of units'],
      ['rep', 'group_by', 'the month dropped from GROUP BY: one row for the whole year under an arbitrary month label', [[" GROUP BY DATE_FORMAT(d.DocumentDate, '%Y-%m')", '']]],
    ],
    heldout: [['rep', 'stale_snapshot', 'filter on the line snapshot l.BrandNameSnapshot instead of the brand master data', [[` ${BJ}`, ''], ["b.BrandName = 'Homebase Supply'", "l.BrandNameSnapshot = 'Homebase Supply'"]]]],
  },
  {
    intentId: 'products_up_apr_vs_mar_2026',
    category: 'standard',
    difficulty: 'hard',
    failure_class: 'aggregation_shape',
    tags: ['quantity', 'product', 'pivot', 'growth', 'single_month'],
    phrasings: ['Which products sold more units in April 2026 than in March 2026? Show March and April units, March first.'],
    sql: s(`SELECT p.ProductName, ROUND(SUM(CASE WHEN ${MAR_2026} THEN COALESCE(l.Quantity, 0) ELSE 0 END), 3) AS mar_units,
      ROUND(SUM(CASE WHEN ${APR_2026} THEN COALESCE(l.Quantity, 0) ELSE 0 END), 3) AS apr_units
      FROM ${LINES} ${PJ} WHERE ${NC} AND ${win('2026-03-01', '2026-05-01')} GROUP BY p.ProductId, p.ProductName
      HAVING SUM(CASE WHEN ${APR_2026} THEN COALESCE(l.Quantity, 0) ELSE 0 END) > SUM(CASE WHEN ${MAR_2026} THEN COALESCE(l.Quantity, 0) ELSE 0 END)
      ORDER BY p.ProductName ASC`),
    comparison: { mode: 'rowset', compare_columns: ['ProductName', 'mar_units', 'apr_units'], decimals: 3, column_order: ['mar_units', 'apr_units'], null_as_zero: ['mar_units', 'apr_units'] },
    notes: 'A product with April units and none in March sold more in April. column_order keeps March first unless the columns are named like the gold columns.',
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['end'],
      ['rep', 'filter', 'products that sold fewer units in April instead of more', [[`ELSE 0 END) > SUM(CASE WHEN ${MAR_2026}`, `ELSE 0 END) < SUM(CASE WHEN ${MAR_2026}`]]],
      ['rep', 'shape', 'the two month columns swapped', [['AS mar_units,', 'AS apr_units_x,'], ['AS apr_units ', 'AS mar_units '], ['apr_units_x', 'apr_units']]],
    ],
  },
  {
    intentId: 'customers_multi_store_q1_2026',
    category: 'standard',
    difficulty: 'medium',
    failure_class: 'distinct_count',
    tags: ['customer', 'store_location', 'distinct_count', 'quarter'],
    phrasings: ['Which customers bought from more than one store in Q1 2026, and from how many stores?', 'Clients that used 2+ outlets in Q1 2026, with the number of outlets.'],
    sql: `SELECT c.CustomerName, COUNT(DISTINCT d.StoreLocationId) AS store_count FROM SalesDocument d ${CJ} WHERE ${NC} AND ${Q1_2026} GROUP BY c.CustomerId, c.CustomerName HAVING COUNT(DISTINCT d.StoreLocationId) > 1 ORDER BY store_count DESC, c.CustomerName ASC`,
    comparison: { mode: 'rowset' },
    negative: [
      ['cancel'],
      ['start'],
      ['end'],
      ['group_by_name'],
      ['rep', 'count', 'documents counted instead of distinct stores', [['COUNT(DISTINCT d.StoreLocationId)', 'COUNT(*)']]],
    ],
    not_emitted: [
      fixtureLimit('date_col', 'PostingDate instead of DocumentDate', "the documents posted in another quarter do not change any customer's store count above one"),
    ],
  },
  {
    intentId: 'agreements_in_force_2026_01_15',
    category: 'named_entity',
    difficulty: 'easy',
    failure_class: 'time_window',
    tags: ['customer_price', 'master_data', 'as_of'],
    phrasings: ['Which customer-specific prices were already in effect on 15 January 2026? Show customer, product and price.', 'Special price agreements in force at 2026-01-15 (customer, product, agreed price).'],
    sql: `SELECT c.CustomerName, p.ProductName, ROUND(cpp.SalePrice, 2) AS agreed_price FROM CustomerProductPrice cpp JOIN Customer c ON cpp.CustomerId = c.CustomerId JOIN Product p ON cpp.ProductId = p.ProductId WHERE cpp.EffectiveDate <= '2026-01-15' ORDER BY c.CustomerName ASC, p.ProductName ASC`,
    comparison: { mode: 'rowset', decimals: 2 },
    notes: 'Price agreements whose EffectiveDate is on or before the date (master data: the same on every fixture).',
    negative: [
      ['rep', 'date_filter', 'agreements starting on or after the date instead of before it', [["cpp.EffectiveDate <= '2026-01-15'", "cpp.EffectiveDate >= '2026-01-15'"]]],
      ['rep', 'filter', 'date filter dropped (every agreement)', [[" WHERE cpp.EffectiveDate <= '2026-01-15'", '']]],
    ],
    not_emitted: [
      {
        type: 'date_boundary',
        note: 'the as-of date itself left out (< instead of <=)',
        reason: 'equivalent here: no agreement takes effect on 2026-01-15 (master data, the same on every fixture)',
      },
    ],
  },

  // ---- ambiguous readings ----
  {
    intentId: 'valley_corner_how_many_products_q1_2026',
    category: 'ambiguous',
    difficulty: 'medium',
    failure_class: 'ambiguous_metric',
    tags: ['product', 'quantity', 'filter_customer', 'quarter'],
    phrasings: ['How many products did Valley Corner Shop buy in Q1 2026?', 'How many items did Valley Corner Shop purchase in Q1 2026?'],
    sql: `SELECT COUNT(DISTINCT l.ProductId) AS product_count FROM ${LINES} ${CJ} WHERE ${NC} AND c.CustomerName = 'Valley Corner Shop' AND ${Q1_2026}`,
    alternatives: () => [`SELECT ROUND(${QTY}, 3) AS total_qty FROM ${LINES} ${CJ} WHERE ${NC} AND c.CustomerName = 'Valley Corner Shop' AND l.ProductId IS NOT NULL AND ${Q1_2026}`],
    comparison: { mode: 'scalar', decimals: 3 },
    notes: 'Two readings are accepted: the number of different products (the gold) and the number of units (alternative_expected_sql, product lines only).',
    negative: [
      ['cancel'],
      ['start'],
      ['rep', 'filter', 'customer filter dropped', [[" AND c.CustomerName = 'Valley Corner Shop'", '']]],
      ['rep', 'count', 'lines counted (neither products nor units)', [['COUNT(DISTINCT l.ProductId)', 'COUNT(*)']]],
    ],
    not_emitted: [
      fixtureLimit('date_col', 'PostingDate instead of DocumentDate', 'no Valley Corner Shop document is dated in Q1 2026 and posted outside it with a product that changes either reading'),
      fixtureLimit('date_boundary', BOUNDARY_NOTES.end, 'Valley Corner Shop has no non-canceled document dated 2026-04-01 on any fixture'),
    ],
  },
  {
    intentId: 'average_basket_apr_2026',
    category: 'ambiguous',
    difficulty: 'medium',
    failure_class: 'ambiguous_metric',
    tags: ['average_order_value', 'quantity', 'basket', 'single_month'],
    phrasings: ['What was the average basket in April 2026?'],
    sql: `SELECT ROUND(AVG(COALESCE(d.NetAmount, 0)), 2) AS avg_basket_value FROM SalesDocument d WHERE ${NC} AND ${APR_2026}`,
    alternatives: () => [`SELECT ROUND(${QTY} / COUNT(DISTINCT d.SalesDocumentId), 2) AS avg_basket_units FROM ${LINES} WHERE ${NC} AND l.ProductId IS NOT NULL AND ${APR_2026}`],
    comparison: { mode: 'scalar', decimals: 2, tolerance: 0.01 },
    notes: 'Two readings of "average basket" are accepted: the average net value per document (the gold) and the average product units per document (alternative_expected_sql).',
    negative: [
      ['cancel'],
      ['date_col'],
      ['start'],
      ['end'],
      ['month_only', '2026-04'],
      ['metric', 'd.NetAmount', 'd.GrossAmount', 'gross instead of net'],
      ['fan_out'],
    ],
  },

  // ---- abstain (the data cannot answer) ----
  {
    intentId: 'stock_on_hand_cane_sugar',
    answer: false,
    expected_behavior: 'abstain',
    category: 'unanswerable',
    difficulty: 'easy',
    failure_class: 'abstention',
    tags: ['unanswerable'],
    phrasings: ['How many units of Cane Sugar 2kg do we have in stock right now?'],
    notes: 'The schema has sales, prices and ledger postings but no inventory or stock levels; the honest answer is that the data cannot tell.',
  },
  {
    intentId: 'salesperson_top_closer_mar_2026',
    answer: false,
    expected_behavior: 'abstain',
    category: 'unanswerable',
    difficulty: 'easy',
    failure_class: 'abstention',
    tags: ['unanswerable'],
    phrasings: ['Which salesperson closed the most deals in March 2026?'],
    notes: 'No table records a salesperson or sales rep for a document.',
  },
];

export const HOLDOUT_INTENTS = INTENTS;

// --- assembly ------------------------------------------------------------------------

const TABLE_REFERENCE = /\b(?:FROM|JOIN)\s+([A-Z][A-Za-z]+)\b/g;

function tablesOf(sql) {
  return [...new Set([...sql.matchAll(TABLE_REFERENCE)].map((match) => match[1]))];
}

function goldOf(intent) {
  if (intent.series) {
    return s(intent.series(MONTH_LABELS.ym));
  }
  return s(intent.sql);
}

function alternativesOf(intent, gold) {
  const alternatives = [];
  if (intent.series) {
    for (const label of intent.seriesLabels || []) {
      alternatives.push(s(intent.series(MONTH_LABELS[label])));
    }
  }
  if (intent.alternatives) {
    alternatives.push(...intent.alternatives(gold).map(s));
  }
  return alternatives;
}

function phrasingOf(phrasing) {
  return typeof phrasing === 'string' ? { q: phrasing } : phrasing;
}

/**
 * Builds the dataset and its controls in memory. `previousCases` (the
 * committed dataset) supplies the expected_row_counts of cases whose id and
 * gold SQL are unchanged. `layer` is the parsed semantic layer, used only to
 * reject holdout wording that contains its vocabulary.
 */
export function buildHoldoutDataset({ previousCases = [], layer = null } = {}) {
  const previous = new Map((previousCases || []).map((testCase) => [testCase.id, testCase]));
  const phrases = layer ? semanticLayerPhrases(layer) : null;
  const cases = [];
  const controls = {};
  const problems = [];
  const seenIntents = new Set();
  const seenIds = new Set();

  for (const intent of INTENTS) {
    if (seenIntents.has(intent.intentId)) {
      problems.push(`duplicate intent ${intent.intentId}`);
    }
    seenIntents.add(intent.intentId);
    const phrasings = intent.phrasings.map(phrasingOf);
    if (phrasings.length < 1 || phrasings.length > 3) {
      problems.push(`${intent.intentId}: ${phrasings.length} phrasings (want 1-3)`);
    }
    const answer = intent.answer !== false;
    let gold = null;
    let alternatives = [];
    if (answer) {
      try {
        gold = goldOf(intent);
        alternatives = alternativesOf(intent, gold);
      } catch (error) {
        problems.push(`${intent.intentId}: ${error.message}`);
        continue;
      }
    }
    const ids = [];
    for (const phrasing of phrasings) {
      const question = phrasing.q;
      if (phrases) {
        const found = semanticLayerPhrasesIn(question, phrases);
        if (found.length > 0) {
          problems.push(`${intent.intentId}: "${question}" contains semantic-layer vocabulary: ${found.join(', ')}`);
        }
        if (/\brevenues?\b/i.test(question.replace(/Sales Revenue/g, ''))) {
          problems.push(`${intent.intentId}: "${question}" uses the enforced metric word "revenue"`);
        }
      }
      const id = holdoutCaseIdFor(intent.intentId, question);
      if (seenIds.has(id)) {
        problems.push(`duplicate case id ${id}`);
      }
      seenIds.add(id);
      ids.push(id);
      const tags = [...new Set(['holdout_v2', intent.category, ...(intent.tags || []), ...(phrasing.tags || [])])];
      const failureClass = phrasing.failure_class || intent.failure_class || null;
      if (!answer) {
        cases.push({
          id,
          intentId: intent.intentId,
          split: 'holdout',
          expected_behavior: intent.expected_behavior,
          question,
          canonicalQuestion: phrasings[0].q,
          difficulty: intent.difficulty,
          tags,
          ...(failureClass ? { failure_class: failureClass } : {}),
          notes: intent.notes,
        });
        continue;
      }
      const prior = previous.get(id);
      const pins = prior && prior.expected_sql === gold && prior.expected_row_counts ? prior.expected_row_counts : undefined;
      cases.push({
        id,
        intentId: intent.intentId,
        split: 'holdout',
        question,
        canonicalQuestion: phrasings[0].q,
        difficulty: intent.difficulty,
        tags,
        ...(failureClass ? { failure_class: failureClass } : {}),
        ...(intent.notes ? { notes: intent.notes } : {}),
        expected_sql: gold,
        ...(alternatives.length ? { alternative_expected_sql: alternatives } : {}),
        expected_tables: tablesOf(gold),
        comparison: intent.comparison,
        ...(phrasing.knownRejection ? { known_validator_rejection: phrasing.knownRejection } : {}),
        ...(pins ? { expected_row_counts: pins } : {}),
      });
    }
    if (!answer) {
      continue;
    }

    const negative = [];
    const seenSql = new Set([gold, ...alternatives]);
    const emit = (spec, prefix, extra) => {
      let knob;
      let sql;
      try {
        knob = buildKnob(KNOBS, spec);
        sql = s(knob.apply(gold));
      } catch (error) {
        problems.push(`${intent.intentId}: control ${JSON.stringify(spec.slice(0, 3))}: ${error.message}`);
        return;
      }
      if (seenSql.has(sql)) {
        problems.push(`${intent.intentId}: control "${knob.note}" equals the gold, an alternative or another control`);
        return;
      }
      seenSql.add(sql);
      const count = negative.filter((control) => control.id.startsWith(prefix)).length;
      negative.push({ id: `${prefix}${count + 1}`, type: knob.type, sql, note: knob.note, ...extra });
    };
    (intent.negative || []).forEach((spec) => emit(spec, 'n', {}));
    (intent.heldout || []).forEach((spec) => emit(spec, 'h', { heldout: true }));
    const positive = [];
    for (const spec of intent.positive || []) {
      try {
        const knob = buildKnob(POSITIVE_KNOBS, spec);
        const sql = s(knob.apply(gold));
        if (seenSql.has(sql)) {
          problems.push(`${intent.intentId}: positive control "${knob.note}" equals the gold or another control`);
          continue;
        }
        seenSql.add(sql);
        positive.push({ id: `p${positive.length + 1}`, sql, note: knob.note });
      } catch (error) {
        problems.push(`${intent.intentId}: positive ${JSON.stringify(spec.slice(0, 2))}: ${error.message}`);
      }
    }
    controls[ids[0]] = {
      intentId: intent.intentId,
      gold_fingerprint: goldFingerprint(gold),
      negative,
      positive,
      ...(intent.not_emitted?.length ? { not_emitted: intent.not_emitted } : {}),
    };
  }

  return { cases, controls, problems };
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  const layer = JSON.parse(await fs.readFile(SEMANTIC_LAYER_PATH, 'utf8'));
  const previousCases = (await readJsonIfExists(DATASET_PATH)) || [];
  const { cases, controls, problems } = buildHoldoutDataset({ previousCases, layer });
  if (problems.length > 0) {
    console.error(`build-holdout-dataset: ${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
    return 1;
  }
  const datasetText = serialize(cases);
  const controlsText = serialize(controls);
  const intents = new Set(cases.map((testCase) => testCase.intentId));
  const negatives = Object.values(controls).reduce((sum, entry) => sum + entry.negative.filter((control) => !control.heldout).length, 0);
  const heldout = Object.values(controls).reduce((sum, entry) => sum + entry.negative.filter((control) => control.heldout).length, 0);
  const positives = Object.values(controls).reduce((sum, entry) => sum + entry.positive.length, 0);
  const summary = `${cases.length} cases, ${intents.size} intents, ${negatives} design + ${heldout} held-out negative and ${positives} positive controls`;
  if (check) {
    const [currentDataset, currentControls] = await Promise.all([
      fs.readFile(DATASET_PATH, 'utf8').catch(() => ''),
      fs.readFile(CONTROLS_PATH, 'utf8').catch(() => ''),
    ]);
    const stale = [currentDataset !== datasetText ? DATASET_PATH : null, currentControls !== controlsText ? CONTROLS_PATH : null].filter(Boolean);
    if (stale.length > 0) {
      console.error(`build-holdout-dataset --check: out of date: ${stale.map((file) => path.relative(ROOT, file)).join(', ')} (run npm run build-holdout-dataset)`);
      return 1;
    }
    console.log(`build-holdout-dataset --check: up to date (${summary}).`);
    return 0;
  }
  await fs.writeFile(DATASET_PATH, datasetText, 'utf8');
  await fs.writeFile(CONTROLS_PATH, controlsText, 'utf8');
  const unpinned = cases.filter((testCase) => !testCase.expected_behavior && !testCase.expected_row_counts).length;
  console.log(`Wrote ${path.relative(ROOT, DATASET_PATH)} and ${path.relative(ROOT, CONTROLS_PATH)}: ${summary}.`);
  if (unpinned > 0) {
    console.log(`${unpinned} case(s) have no expected_row_counts yet: run npm run verify-dataset -- --dataset ${DATASET_NAME} --write-pins (fresh fixtures).`);
  }
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then((code) => {
    process.exitCode = code;
  });
}
