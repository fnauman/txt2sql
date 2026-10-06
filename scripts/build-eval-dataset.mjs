// Templated evaluation dataset: datasets/templated-public.json and its oracle
// controls datasets/controls/templated-public.json (audit plan item 2.6).
//
//   npm run build-eval-dataset            # rewrite both files
//   npm run build-eval-dataset -- --check # exit 1 when the committed files differ
//
// Every intent below is composed from a metric (document-level net sales,
// line-level net sales, gross amount, quantity, document count, distinct
// buying customers, average order value, outstanding balance, paid amount,
// ledger debit/credit), dimensions (customer, store location, document type,
// product, brand, product category, campaign, ledger account, month), a time
// window (single months from November 2025 to May 2026, quarters, explicit
// date ranges, calendar years), optional filters (a store, brand, category,
// campaign, customer, product or document type) and a shape (top-N ranked with
// a LIMIT that binds on v3, ranked list, grouped rowset, scalar, month-by-month
// series, side-by-side pivot). The SQL builders below turn those parts into
// gold SQL with the repo's conventions (IFNULL(IsCanceled, 0) = 0, half-open
// date ranges, COALESCE inside aggregates, ROUND(..., 2|3), line-level amounts
// for product/brand/category/campaign breakdowns, never a header amount summed
// over a line join), plus a comparison block per the comparator spec.
//
// Wording is curated, not generated: each intent lists 2-3 phrasings a
// retail/distribution manager would plausibly type. A phrasing written as
// `{ q, knownRejection: '<code>' }` is one the production validator rejects
// every correct answer to today in the default product configuration (a
// guardrail misreads the wording): the case gets `known_validator_rejection`
// and still counts, so the gap is measured (verify-dataset fails once the
// validator accepts its gold). Retrieval misses are no such gap any more: the
// default schema scope (SCHEMA_SCOPE=auto, full at this schema size) allows
// every in-scope table, and under SCHEMA_SCOPE=retrieved verify-dataset notes
// them instead.
//
// Splits: every templated case is dev. Until the measurement-hygiene change a
// hash rule (wasHoldoutIntent: the first 32 bits of sha256(intentId), mod 100,
// below FORMER_HOLDOUT_PERCENT) put about 42% of the intents in the holdout.
// Those intents were inspected during the Experiment 1 error analysis, so they
// are dev now and tagged `formerly_holdout`; the holdout is authored blind,
// outside this generator, and frozen by datasets/holdout-manifest.json (see
// docs/evaluation-dataset.md).
//
// Case ids are `tpl_<intentId>_<first 6 hex of sha256(question)>`, so editing
// a question yields a new id: an id is never reused for a different question
// (comparisons align cases by id).
//
// Pins: expected_row_counts are carried over from the committed dataset for
// every case whose id and gold SQL are unchanged; `npm run verify-dataset --
// --dataset templated-public --write-pins` (re)writes them. Rerunning this
// script reproduces both files byte for byte (test/dataset-hygiene.test.js).
//
// Controls: per intent, negative controls from the mutation families that
// apply to its template (dropped cancel filter, header <-> line amount, net
// <-> gross, wrong date column, both off-by-one boundaries, MONTH() without
// YEAR(), COUNT vs COUNT DISTINCT, a missing GROUP BY key, wrong ORDER
// direction or missing LIMIT, dropped filter, fee lines counted as units,
// stale snapshot, wrong join path, SUM DISTINCT), and positive controls (CTE,
// derived-table and alias rewrites) for a sample of intents. A family that
// cannot change the answer for an intent (semantically equivalent there, e.g.
// GROUP BY name when names are unique), or that no fixture can separate
// without breaking another designed property (a fixture limit), is not
// emitted; the reason is recorded in the controls file under `not_emitted`
// (see NOT_EMITTED and the template rules in mutationsFor). Held-out controls
// (`h*`, `heldout: true`) come from families the fixtures were deliberately
// not extended against (snapshot filters and grouping, QUARTER() without
// YEAR(), the cancel filter in HAVING, rankings ordered by another amount):
// their kill rate is reported, not gated.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATASET_NAME = 'templated-public';
export const DATASET_PATH = path.join(ROOT, 'datasets', `${DATASET_NAME}.json`);
export const CONTROLS_PATH = path.join(ROOT, 'datasets', 'controls', `${DATASET_NAME}.json`);

// --- splits -------------------------------------------------------------------

// The split of every templated case (see the file comment).
export const TEMPLATED_SPLIT = 'dev';

// The retired holdout rule, kept to tag the intents it used to hold out.
export const FORMER_HOLDOUT_PERCENT = 42;
export const FORMERLY_HOLDOUT_TAG = 'formerly_holdout';

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

/**
 * True for the intents the retired hash rule put in the holdout (about
 * FORMER_HOLDOUT_PERCENT% of intent ids). The hand-written hard cases used the
 * same rule, unless they rephrase an existing intent.
 */
export function wasHoldoutIntent(intentId) {
  return Number.parseInt(sha256Hex(intentId).slice(0, 8), 16) % 100 < FORMER_HOLDOUT_PERCENT;
}

export function caseIdFor(intentId, question) {
  return `tpl_${intentId}_${sha256Hex(question).slice(0, 6)}`;
}

/** Same rule as controls.goldFingerprint (whitespace-normalized sha256, 16 hex). */
function goldFingerprint(sql) {
  return sha256Hex(String(sql || '').replace(/\s+/g, ' ').trim()).slice(0, 16);
}

// --- time windows ---------------------------------------------------------------

// Both off-by-one mutants are emitted for every window; `boundary` names the
// side every fixture separates for that window, emitted first: 'start' (the
// first day dropped: v3 has documents on the first day of every month) or
// 'end' (the day after the window included). `prior` marks single months
// whose calendar month also has rows a year earlier on some fixture, so
// MONTH() without YEAR() changes the answer (v2 has 2024-11, 2024-12 and
// 2025-02 to 2025-05 rows; v3 has 2025-01 to 2025-03).
const WINDOWS = {
  '2025-11': { start: '2025-11-01', end: '2025-12-01', month: 11, prior: true, boundary: 'start' },
  '2025-12': { start: '2025-12-01', end: '2026-01-01', month: 12, prior: true, boundary: 'start' },
  '2025-03': { start: '2025-03-01', end: '2025-04-01', month: 3, boundary: 'start' },
  '2026-01': { start: '2026-01-01', end: '2026-02-01', month: 1, prior: true, boundary: 'start' },
  '2026-02': { start: '2026-02-01', end: '2026-03-01', month: 2, prior: true, boundary: 'start' },
  '2026-03': { start: '2026-03-01', end: '2026-04-01', month: 3, prior: true, boundary: 'start' },
  '2026-04': { start: '2026-04-01', end: '2026-05-01', month: 4, prior: true, boundary: 'start' },
  '2026-05': { start: '2026-05-01', end: '2026-06-01', month: 5, prior: true, boundary: 'start' },
  'q4-2025': { start: '2025-10-01', end: '2026-01-01', boundary: 'end' },
  'q1-2025': { start: '2025-01-01', end: '2025-04-01', boundary: 'start' },
  'q1-2026': { start: '2026-01-01', end: '2026-04-01', boundary: 'start' },
  'y2025': { start: '2025-01-01', end: '2026-01-01', boundary: 'end' },
  'y2026': { start: '2026-01-01', end: '2027-01-01', boundary: 'start' },
  'nov25-feb26': { start: '2025-11-01', end: '2026-03-01', boundary: 'start' },
  'feb15-mar15': { start: '2026-02-15', end: '2026-03-16', boundary: 'end' },
  'mar01-10': { start: '2026-03-01', end: '2026-03-11', boundary: 'start' },
  'apr-may-2026': { start: '2026-04-01', end: '2026-06-01', boundary: 'start' },
};

// Months each multi-month window covers (series alternatives need to know
// whether the window stays inside one calendar year).
function windowSpansYears(window) {
  return window.start.slice(0, 4) !== addDays(window.end, -1).slice(0, 4);
}

function addDays(isoDate, days) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

// --- SQL parts ----------------------------------------------------------------------

const CANCEL = 'IFNULL(d.IsCanceled, 0) = 0';
const LINE_FROM = 'SalesDocumentLine l JOIN SalesDocument d ON l.SalesDocumentId = d.SalesDocumentId';
const PRODUCT_JOIN = 'JOIN Product p ON l.ProductId = p.ProductId';

const METRICS = {
  net: { grain: 'header', agg: 'sum', column: 'd.NetAmount', alias: 'total_net_amount', decimals: 2, tags: ['net_sales'] },
  gross: { grain: 'header', agg: 'sum', column: 'd.GrossAmount', alias: 'total_gross_amount', decimals: 2, tags: ['gross_amount'] },
  balance: { grain: 'header', agg: 'sum', column: 'd.BalanceAmount', alias: 'outstanding_balance', decimals: 2, tags: ['outstanding_balance'] },
  paid: { grain: 'header', agg: 'sum', column: 'd.PaidAmount', alias: 'total_paid_amount', decimals: 2, tags: ['paid_amount'] },
  docs: { grain: 'header', agg: 'count', alias: 'document_count', tags: ['document_count'] },
  customers: { grain: 'any', agg: 'count_distinct', column: 'd.CustomerId', alias: 'customer_count', tags: ['distinct_customers'] },
  aov: { grain: 'header', agg: 'avg', column: 'd.NetAmount', alias: 'avg_order_value', decimals: 2, tolerance: 0.01, tags: ['average_order_value'] },
  line_net: { grain: 'line', agg: 'sum', column: 'l.NetAmount', alias: 'total_net_amount', decimals: 2, tolerance: 0.01, tags: ['line_net_sales'] },
  qty: { grain: 'line', agg: 'sum', column: 'l.Quantity', alias: 'total_qty', decimals: 3, tags: ['quantity'] },
};

// The plausible wrong measure for each metric (the "metric" mutant).
const METRIC_SWAPS = {
  net: { column: 'd.GrossAmount', note: 'gross instead of net' },
  gross: { column: 'd.NetAmount', note: 'net instead of gross' },
  balance: { column: 'd.NetPayableAmount', note: 'payable amount instead of the outstanding balance' },
  paid: { column: 'd.BalanceAmount', note: 'outstanding balance instead of the paid amount' },
  aov: { column: 'd.GrossAmount', note: 'gross instead of net in the average' },
  line_net: { column: 'l.TotalAmount', note: 'line TotalAmount (before adjustments) instead of line NetAmount' },
};

const DIMS = {
  customer: { grain: 'header', joins: ['JOIN Customer c ON d.CustomerId = c.CustomerId'], key: 'c.CustomerId', name: 'c.CustomerName', column: 'CustomerName', uniqueNames: false, tag: 'customer' },
  store: { grain: 'header', joins: ['JOIN StoreLocation s ON d.StoreLocationId = s.StoreLocationId'], key: 's.StoreLocationId', name: 's.LocationName', column: 'LocationName', uniqueNames: true, tag: 'store_location' },
  doctype: { grain: 'header', joins: ['JOIN DocumentType t ON d.DocumentTypeId = t.DocumentTypeId'], key: 't.DocumentTypeId', name: 't.DocumentTypeName', column: 'DocumentTypeName', uniqueNames: true, tag: 'document_type' },
  product: { grain: 'line', joins: [PRODUCT_JOIN], key: 'p.ProductId', name: 'p.ProductName', column: 'ProductName', uniqueNames: true, tag: 'product', heldoutSnapshot: 'l.ProductNameSnapshot' },
  brand: { grain: 'line', joins: [PRODUCT_JOIN, 'JOIN Brand b ON p.BrandId = b.BrandId'], key: 'b.BrandId', name: 'b.BrandName', column: 'BrandName', uniqueNames: true, tag: 'brand', snapshot: 'l.BrandNameSnapshot' },
  category: { grain: 'line', joins: [PRODUCT_JOIN, 'JOIN ProductCategory pc ON p.ProductCategoryId = pc.ProductCategoryId'], key: 'pc.ProductCategoryId', name: 'pc.CategoryName', column: 'CategoryName', uniqueNames: true, tag: 'product_category', snapshot: 'l.CategoryNameSnapshot' },
  campaign: { grain: 'line', joins: [PRODUCT_JOIN, 'JOIN Campaign cp ON p.CampaignId = cp.CampaignId'], key: 'cp.CampaignId', name: 'cp.CampaignName', column: 'CampaignName', uniqueNames: true, tag: 'campaign' },
};

// Plausible wrong join paths per dimension (the "join_path" mutant).
const WRONG_JOINS = {
  brand: {
    joins: [PRODUCT_JOIN, 'JOIN ProductBrand pb ON pb.ProductId = p.ProductId', 'JOIN Brand b ON pb.BrandId = b.BrandId'],
    note: 'brand through the ProductBrand bridge (only some products have a row) instead of Product.BrandId',
  },
  category: {
    joins: [PRODUCT_JOIN, 'JOIN Brand b ON p.BrandId = b.BrandId', 'JOIN ProductCategory pc ON b.ProductCategoryId = pc.ProductCategoryId'],
    note: "category through the brand's default category instead of Product.ProductCategoryId",
  },
  campaign: {
    joins: ['JOIN Campaign cp ON d.CampaignId = cp.CampaignId'],
    note: "campaign through the document header's CampaignId instead of the product's campaign",
  },
};

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function aggregate(metric, { column = metric.column, distinct = false } = {}) {
  switch (metric.agg) {
    case 'sum':
      return distinct ? `SUM(DISTINCT COALESCE(${column}, 0))` : `SUM(COALESCE(${column}, 0))`;
    case 'avg':
      return `AVG(COALESCE(${column}, 0))`;
    case 'count':
      return 'COUNT(*)';
    case 'count_distinct':
      return `COUNT(DISTINCT ${column})`;
    default:
      throw new Error(`unknown aggregate ${metric.agg}`);
  }
}

function projected(metric, expression, alias = metric.alias) {
  return metric.decimals != null ? `ROUND(${expression}, ${metric.decimals}) AS ${alias}` : `${expression} AS ${alias}`;
}

function render(q) {
  return [
    q.with ? `WITH ${q.with}` : null,
    `SELECT ${q.select.join(', ')}`,
    `FROM ${q.from}`,
    ...q.joins,
    q.where.length ? `WHERE ${q.where.join(' AND ')}` : null,
    q.groupBy.length ? `GROUP BY ${q.groupBy.join(', ')}` : null,
    q.having ? `HAVING ${q.having}` : null,
    q.orderBy.length ? `ORDER BY ${q.orderBy.join(', ')}` : null,
    q.limit != null ? `LIMIT ${q.limit}` : null,
  ]
    .filter(Boolean)
    .join(' ');
}

function uniqueJoins(joins) {
  return [...new Set(joins)];
}

// Filters: a dimension member by name (LIKE with wildcards, per the business
// rules), or a ledger account by code.
function filterPredicate(filter) {
  const dim = DIMS[filter.dim];
  return `${dim.name} LIKE ${sqlString(`%${filter.value}%`)}`;
}

// The line snapshot column a filter on a line-grain dimension could
// (wrongly) use instead of the master data (held-out mutants).
const FILTER_SNAPSHOTS = { brand: 'l.BrandNameSnapshot', category: 'l.CategoryNameSnapshot', product: 'l.ProductNameSnapshot' };

function windowPredicates(window, column = 'd.DocumentDate', { boundary = null } = {}) {
  return [
    `${column} ${boundary === 'start' ? '>' : '>='} ${sqlString(window.start)}`,
    `${column} ${boundary === 'end' ? '<=' : '<'} ${sqlString(window.end)}`,
  ];
}

// A quarter written as QUARTER() alone, without the year (held-out mutant).
function quarterOnlyPredicate(window, column) {
  const month = Number(window.start.slice(5, 7));
  return `QUARTER(${column}) = ${Math.floor((month - 1) / 3) + 1}`;
}

function isQuarterWindow(window) {
  const [startYear, startMonth] = window.start.split('-').map(Number);
  const [endYear, endMonth] = window.end.split('-').map(Number);
  return window.start.endsWith('-01') && window.end.endsWith('-01') && (startMonth - 1) % 3 === 0 &&
    (endYear * 12 + endMonth) - (startYear * 12 + startMonth) === 3;
}

// Month label expressions for series: the gold and the accepted alternatives
// (a month can be labelled '2026-01', '2026-01-01', 1, 'January', 'Jan 2026'
// or 'January 2026').
const MONTH_LABELS = {
  ym: (column) => `DATE_FORMAT(${column}, '%Y-%m')`,
  ymd: (column) => `DATE_FORMAT(${column}, '%Y-%m-01')`,
  num: (column) => `MONTH(${column})`,
  name: (column) => `MONTHNAME(${column})`,
  abbrYear: (column) => `DATE_FORMAT(${column}, '%b %Y')`,
  nameYear: (column) => `DATE_FORMAT(${column}, '%M %Y')`,
};

/**
 * Fact query (SalesDocument, optionally its lines): metric by dimensions over a
 * window, with filters, a shape and an optional month series. `m` holds the
 * mutation knobs used to build negative controls.
 */
function factQuery(spec, m = {}) {
  const metric = METRICS[spec.metric];
  const dims = (spec.dims || []).map((dimKey) => ({ dimKey, ...DIMS[dimKey] }));
  const filters = spec.filters || [];
  const filterDims = filters.map((filter) => DIMS[filter.dim]);
  const lineGrain =
    metric.grain === 'line' || dims.some((dim) => dim.grain === 'line') || filterDims.some((dim) => dim.grain === 'line') || m.fanOut || m.lineMetric;
  if (lineGrain && metric.grain === 'header' && !m.fanOut && !m.lineMetric) {
    throw new Error(`${spec.intentId}: a header metric over a line join would fan out`);
  }
  const window = WINDOWS[spec.window];
  const dateColumn = `d.${m.dateColumn || spec.dateColumn || 'DocumentDate'}`;

  const joins = [];
  for (const dim of dims) {
    joins.push(...(m.wrongJoin === dim.dimKey ? WRONG_JOINS[dim.dimKey].joins : dim.joins));
  }
  filters.forEach((filter, index) => {
    if (m.dropFilter !== index && m.snapshotFilter !== index) {
      joins.push(...DIMS[filter.dim].joins);
    }
  });

  let metricColumn = m.metricColumn || metric.column;
  let metricExpression = aggregate(metric, { column: metricColumn, distinct: m.sumDistinct });
  if (m.countStar) {
    metricExpression = 'COUNT(*)';
  } else if (m.distinctNames) {
    metricExpression = 'COUNT(DISTINCT c.CustomerName)';
    joins.push(...DIMS.customer.joins);
  } else if (m.lineMetric) {
    metricExpression = aggregate(METRICS.line_net, { column: 'l.NetAmount' });
  } else if (m.headerMetric) {
    metricExpression = aggregate(metric, { column: m.headerMetric });
  }

  const select = [];
  const groupBy = [];
  const snapshotOf = (dim) => dim.snapshot || dim.heldoutSnapshot;
  for (const dim of dims) {
    if (m.snapshot === dim.dimKey) {
      select.push(`${snapshotOf(dim)} AS ${dim.column}`);
      groupBy.push(snapshotOf(dim));
    } else {
      select.push(dim.name);
      if (m.dropGroupKey !== dim.dimKey) {
        groupBy.push(...(m.groupByName === dim.dimKey ? [dim.name] : [dim.key, dim.name]));
      }
    }
  }
  let label = null;
  if (spec.series) {
    label = MONTH_LABELS[m.monthLabel || 'ym'](dateColumn === 'd.DocumentDate' ? 'd.DocumentDate' : dateColumn);
    select.push(`${label} AS sales_month`);
    if (m.dropGroupKey !== 'month') {
      groupBy.push(label);
    }
  }
  select.push(projected(metric, metricExpression));

  const where = m.dropCancel || m.havingCancel ? [] : [CANCEL];
  if (m.monthOnly) {
    where.push(`MONTH(${dateColumn}) = ${window.month}`);
  } else if (m.quarterOnly) {
    where.push(quarterOnlyPredicate(window, dateColumn));
  } else {
    where.push(...windowPredicates(window, dateColumn, { boundary: m.boundary }));
  }
  filters.forEach((filter, index) => {
    if (m.snapshotFilter === index) {
      where.push(`${FILTER_SNAPSHOTS[filter.dim]} LIKE ${sqlString(`%${filter.value}%`)}`);
    } else if (m.dropFilter !== index) {
      where.push(filterPredicate(filter));
    }
  });
  // Units are product units: without a product, brand, category or campaign
  // join (which drops them), the gold leaves out the NULL-ProductId
  // delivery-fee lines (Quantity 1) explicitly.
  const productJoined = dims.some((dim) => dim.grain === 'line') || filterDims.some((dim) => dim.grain === 'line');
  if (spec.metric === 'qty' && !productJoined && !m.feeLines) {
    where.push('l.ProductId IS NOT NULL');
  }

  const orderBy = [];
  const ranked = spec.shape === 'top' || spec.shape === 'rank';
  const orderExpression = m.orderColumn ? aggregate(metric, { column: m.orderColumn }) : metricExpression;
  if (spec.series) {
    orderBy.push(...dims.map((dim) => `${dim.name} ASC`), 'sales_month ASC');
  } else if (dims.length > 0) {
    if (ranked || spec.shape === 'breakdown') {
      orderBy.push(`${orderExpression} ${m.orderAsc ? 'ASC' : 'DESC'}`, ...dims.map((dim) => (m.snapshot === dim.dimKey ? `${snapshotOf(dim)} ASC` : `${dim.name} ASC`)));
    }
  }

  return render({
    select,
    from: lineGrain ? LINE_FROM : 'SalesDocument d',
    joins: uniqueJoins(joins),
    where,
    groupBy,
    having: m.havingCancel ? `MAX(${CANCEL.replace(' = 0', '')}) = 0` : null,
    orderBy,
    limit: spec.shape === 'top' && !m.noLimit ? spec.limit : null,
  });
}

/**
 * Two windows side by side (one column per window), optionally by a
 * dimension. `columns` are the output aliases in window order.
 */
function pivotQuery(spec, m = {}) {
  const metric = METRICS[spec.metric];
  const dim = spec.dim ? { name: spec.dim, ...DIMS[spec.dim] } : null;
  const [first, second] = spec.windows.map((key) => WINDOWS[key]);
  const dateColumn = `d.${m.dateColumn || 'DocumentDate'}`;
  const inWindow = (window) => windowPredicates(window, dateColumn, { boundary: m.boundary }).join(' AND ');
  const column = m.metricColumn || metric.column;
  const pieces = (m.swapColumns ? [second, first] : [first, second]).map(
    (window, index) => `ROUND(SUM(CASE WHEN ${inWindow(window)} THEN COALESCE(${column}, 0) ELSE 0 END), 2) AS ${spec.columns[index]}`
  );
  const contiguous = first.end === second.start;
  const range = contiguous
    ? windowPredicates({ start: first.start, end: second.end }, dateColumn, { boundary: m.boundary })
    : [`((${inWindow(first)}) OR (${inWindow(second)}))`];
  if (m.everyCustomer) {
    return render({
      select: [dim.name, ...pieces],
      from: 'Customer c',
      joins: [`LEFT JOIN SalesDocument d ON d.CustomerId = c.CustomerId AND ${CANCEL} AND ${range.join(' AND ')}`],
      where: [],
      groupBy: [dim.key, dim.name],
      orderBy: [`${dim.name} ASC`],
      limit: null,
    });
  }
  return render({
    select: [...(dim ? [dim.name] : []), ...pieces],
    from: 'SalesDocument d',
    joins: dim ? dim.joins : [],
    where: [...(m.dropCancel ? [] : [CANCEL]), ...range],
    groupBy: dim ? [dim.key, dim.name] : [],
    orderBy: dim ? [`${dim.name} ASC`] : [],
    limit: null,
  });
}

/**
 * Ledger postings by account. dateMode 'document': postings of non-canceled
 * sales documents dated in the window (the core cases' convention);
 * 'posting': postings dated in the window by AccountingPosting.PostingDate,
 * manual journals included (the alternative excludes postings of canceled
 * documents).
 */
const LEDGER_MEASURES = {
  debit: { expression: 'SUM(COALESCE(p.DebitAmount, 0))', alias: 'total_debit', decimals: 2 },
  credit: { expression: 'SUM(COALESCE(p.CreditAmount, 0))', alias: 'total_credit', decimals: 2 },
  net_movement: { expression: 'SUM(COALESCE(p.DebitAmount, 0) - COALESCE(p.CreditAmount, 0))', alias: 'net_movement', decimals: 2 },
  postings: { expression: 'COUNT(*)', alias: 'posting_count' },
};

function ledgerQuery(spec, m = {}) {
  const window = WINDOWS[spec.window];
  const measures = spec.measures.map((name) => {
    const measure = LEDGER_MEASURES[name];
    let expression = measure.expression;
    if (m.swapDebitCredit) {
      expression = expression.replace(/DebitAmount/g, '\u0000').replace(/CreditAmount/g, 'DebitAmount').replace(/\u0000/g, 'CreditAmount');
    } else if (m.netMovement && name === 'debit') {
      expression = LEDGER_MEASURES.net_movement.expression;
    } else if (m.netMovement && name === 'credit') {
      expression = 'SUM(COALESCE(p.CreditAmount, 0) - COALESCE(p.DebitAmount, 0))';
    }
    return measure.decimals != null ? `ROUND(${expression}, ${measure.decimals}) AS ${measure.alias}` : `${expression} AS ${measure.alias}`;
  });
  // One account (a code filter) or the manual journals as a whole are one
  // total; otherwise a row per account.
  const byAccount = !spec.accountCode && !spec.manualOnly;
  const select = [];
  const groupBy = [];
  if (byAccount) {
    select.push('a.AccountCode', 'a.AccountName');
    groupBy.push('a.LedgerAccountId', 'a.AccountCode', 'a.AccountName');
  }
  const documentMode = spec.dateMode === 'document';
  const useDocumentDate = documentMode !== Boolean(m.otherDateColumn);
  const dateColumn = useDocumentDate ? 'd.DocumentDate' : 'p.PostingDate';
  let label = null;
  if (spec.series) {
    label = MONTH_LABELS[m.monthLabel || 'ym'](dateColumn);
    select.push(`${label} AS posting_month`);
    if (m.dropGroupKey !== 'month') {
      groupBy.push(label);
    }
  }
  select.push(...measures);

  // The account join is needed for a per-account breakdown or an account
  // filter; a manual-journal total reads AccountingPosting alone.
  const joins = byAccount || spec.accountCode ? ['JOIN LedgerAccount a ON p.LedgerAccountId = a.LedgerAccountId'] : [];
  const where = [];
  if (documentMode || useDocumentDate || m.innerJoinCancel) {
    joins.push('JOIN SalesDocument d ON p.SalesDocumentId = d.SalesDocumentId');
    if (!m.dropCancel) {
      where.push(CANCEL);
    }
  } else if (m.leftJoinCancel) {
    joins.push('LEFT JOIN SalesDocument d ON p.SalesDocumentId = d.SalesDocumentId');
    where.push(CANCEL);
  }
  if (m.monthOnly) {
    where.push(`MONTH(${dateColumn}) = ${window.month}`);
  } else if (m.quarterOnly) {
    where.push(quarterOnlyPredicate(window, dateColumn));
  } else {
    where.push(...windowPredicates(window, dateColumn, { boundary: m.boundary }));
  }
  if (spec.accountCode && !m.dropFilter) {
    where.push(`a.AccountCode = ${sqlString(spec.accountCode)}`);
  }
  if (spec.manualOnly && !m.dropFilter) {
    where.push('p.SalesDocumentId IS NULL');
  }
  return render({
    select,
    from: 'AccountingPosting p',
    joins,
    where,
    groupBy,
    orderBy: spec.series ? ['posting_month ASC'] : byAccount ? ['a.AccountCode ASC'] : [],
    limit: null,
  });
}

// Special one-off templates (each builds its own SQL; mutants listed with it).
const CUSTOM = {
  // Customers active in master data with no non-canceled document in a window.
  active_customers_without_sales(spec, m = {}) {
    const window = WINDOWS[spec.window];
    const inner = [
      'd.CustomerId = c.CustomerId',
      ...(m.dropCancel ? [] : [CANCEL]),
      ...windowPredicates(window, `d.${m.dateColumn || 'DocumentDate'}`, { boundary: m.boundary }),
    ].join(' AND ');
    return render({
      select: ['c.CustomerName'],
      from: 'Customer c',
      joins: [],
      where: [...(m.dropActive ? [] : ['c.IsActive = 1']), `NOT EXISTS (SELECT 1 FROM SalesDocument d WHERE ${inner})`],
      groupBy: [],
      orderBy: ['c.CustomerName ASC'],
      limit: null,
    });
  },
  // Customers with a non-canceled document in one month but not the next.
  customers_lost_between(spec, m = {}) {
    const [first, second] = spec.windows.map((key) => WINDOWS[key]);
    const cancel = m.dropCancel || m.dropCancelFirst ? '' : `${CANCEL} AND `;
    const secondCancel = m.dropCancelSecond || m.dropCancel ? '' : `${CANCEL} AND `;
    const range = (window, boundary) => windowPredicates(window, `d.${m.dateColumn || 'DocumentDate'}`, { boundary }).join(' AND ');
    // countDocs: the DISTINCT forgotten in the first month's set, so COUNT(*)
    // counts that month's documents of the lost customers.
    const count = m.countDocs ? 'COUNT(*)' : 'COUNT(DISTINCT f.CustomerId)';
    return (
      `WITH firstMonth AS (SELECT ${m.countDocs ? '' : 'DISTINCT '}d.CustomerId FROM SalesDocument d WHERE ${cancel}${range(first, m.boundary)}), ` +
      `secondMonth AS (SELECT DISTINCT d.CustomerId FROM SalesDocument d WHERE ${secondCancel}${range(second, m.boundary)}) ` +
      `SELECT ${count} AS customer_count FROM firstMonth f LEFT JOIN secondMonth s ON s.CustomerId = f.CustomerId WHERE s.CustomerId IS NULL`
    );
  },
  // Latest non-canceled document date per customer (all time).
  last_purchase_date(spec, m = {}) {
    if (m.everyCustomer) {
      return render({
        select: ['c.CustomerName', 'MAX(d.DocumentDate) AS last_purchase_date'],
        from: 'Customer c',
        joins: [`LEFT JOIN SalesDocument d ON d.CustomerId = c.CustomerId AND ${CANCEL}`],
        where: [],
        groupBy: ['c.CustomerId', 'c.CustomerName'],
        orderBy: ['c.CustomerName ASC'],
        limit: null,
      });
    }
    return render({
      select: ['c.CustomerName', `${m.minDate ? 'MIN' : 'MAX'}(d.${m.dateColumn || 'DocumentDate'}) AS last_purchase_date`],
      from: 'SalesDocument d',
      joins: DIMS.customer.joins,
      where: m.dropCancel ? [] : [CANCEL],
      groupBy: m.groupByName ? ['c.CustomerName'] : ['c.CustomerId', 'c.CustomerName'],
      orderBy: ['c.CustomerName ASC'],
      limit: null,
    });
  },
  // The single largest document of a window.
  largest_document(spec, m = {}) {
    const window = WINDOWS[spec.window];
    const column = m.metricColumn || 'd.NetAmount';
    return render({
      select: ['d.DocumentNo', `ROUND(COALESCE(${column}, 0), 2) AS net_amount`],
      from: 'SalesDocument d',
      joins: [],
      where: [...(m.dropCancel ? [] : [CANCEL]), ...windowPredicates(window, `d.${m.dateColumn || 'DocumentDate'}`, { boundary: m.boundary })],
      groupBy: [],
      orderBy: [`COALESCE(${m.orderColumn || column}, 0) ${m.orderAsc ? 'ASC' : 'DESC'}`, 'd.DocumentNo ASC'],
      limit: 1,
    });
  },
  // Canceled documents of a window (count, optionally by store with value).
  canceled_documents(spec, m = {}) {
    const window = WINDOWS[spec.window];
    const canceled = m.dropCancel ? null : m.invertCancel ? CANCEL : 'd.IsCanceled = 1';
    const dims = spec.dim ? [{ name: spec.dim, ...DIMS[spec.dim] }] : [];
    const measures = spec.withValue
      ? ['COUNT(*) AS document_count', `ROUND(SUM(COALESCE(${m.metricColumn || 'd.NetAmount'}, 0)), 2) AS canceled_net_amount`]
      : ['COUNT(*) AS document_count'];
    return render({
      select: [...dims.map((dim) => dim.name), ...measures],
      from: 'SalesDocument d',
      joins: dims.flatMap((dim) => dim.joins),
      where: [...(canceled ? [canceled] : []), ...windowPredicates(window, `d.${m.dateColumn || 'DocumentDate'}`, { boundary: m.boundary })],
      groupBy: dims.flatMap((dim) => [dim.key, dim.name]),
      orderBy: dims.map((dim) => `${dim.name} ASC`),
      limit: null,
    });
  },
  // Net sales per calendar year (all data).
  net_sales_by_year(spec, m = {}) {
    const column = m.metricColumn || 'd.NetAmount';
    const year = `YEAR(d.${m.dateColumn || 'DocumentDate'})`;
    return render({
      select: [`${year} AS sales_year`, `ROUND(SUM(COALESCE(${column}, 0)), 2) AS total_net_amount`],
      from: m.fanOut ? LINE_FROM : 'SalesDocument d',
      joins: [],
      where: m.dropCancel ? [] : [CANCEL],
      groupBy: [year],
      orderBy: ['sales_year ASC'],
      limit: null,
    });
  },
};

// --- the intent catalogue ---------------------------------------------------------------
//
// template: 'fact' (factQuery), 'pivot', 'ledger', or a CUSTOM key.
// shape (fact): 'top' (ranked + LIMIT), 'rank' (ranked, no LIMIT), 'breakdown'
// (grouped rowset), 'scalar'; `series: true` adds a month label.
// difficulty, failure_class and extra tags are optional overrides.

const INTENTS = [
  // ---- document-level net sales ----
  {
    intentId: 'customer_net_sales_top3_feb_2026', template: 'fact', metric: 'net', dims: ['customer'], window: '2026-02', shape: 'top', limit: 3,
    phrasings: [
      'Which three customers generated the most net sales in February 2026?',
      'Top 3 customers by net revenue for February 2026.',
      'Name our three largest customers by net sales value in February 2026.',
    ],
  },
  {
    intentId: 'customer_net_sales_top5_q1_2026', template: 'fact', metric: 'net', dims: ['customer'], window: 'q1-2026', shape: 'top', limit: 5,
    phrasings: [
      'Who were our top 5 customers by turnover in Q1 2026?',
      'Rank customers by net amount billed for January through March 2026 and show the top five.',
    ],
  },
  {
    intentId: 'customer_net_sales_apr_2026', template: 'fact', metric: 'net', dims: ['customer'], window: '2026-04', shape: 'breakdown',
    phrasings: [
      'Net takings per customer in April 2026.',
      'How much did each customer spend with us in April 2026, excluding tax?',
    ],
  },
  {
    intentId: 'customer_net_sales_top3_dec_2025', template: 'fact', metric: 'net', dims: ['customer'], window: '2025-12', shape: 'top', limit: 3,
    phrasings: [
      'Top three customers by net sales in December 2025.',
      'Which 3 clients spent the most with us in December 2025, measured by net amount?',
    ],
  },
  {
    intentId: 'customer_net_sales_rank_nov_2025', template: 'fact', metric: 'net', dims: ['customer'], window: '2025-11', shape: 'rank',
    phrasings: [
      'Rank the customers who bought from us in November 2025 by net revenue.',
      'List the November 2025 buyers from highest to lowest net amount, all document types included.',
    ],
  },
  {
    intentId: 'doctype_net_sales_q1_2026', template: 'fact', metric: 'net', dims: ['doctype'], window: 'q1-2026', shape: 'breakdown',
    phrasings: [
      'Turnover by type of document for Q1 2026.',
      'Break down first-quarter 2026 net takings by kind of document.',
    ],
  },
  {
    intentId: 'doctype_net_sales_top1_may_2026', template: 'fact', metric: 'net', dims: ['doctype'], window: '2026-05', shape: 'top', limit: 1,
    phrasings: [
      'Which document type brought in the most net sales in May 2026?',
      'In May 2026, what kind of document carried the highest net revenue?',
    ],
  },
  {
    intentId: 'total_net_sales_feb_2026', template: 'fact', metric: 'net', window: '2026-02', shape: 'scalar',
    phrasings: [
      'What were total net sales in February 2026?',
      'How much net revenue did we make in February 2026?',
    ],
  },
  {
    intentId: 'total_net_sales_q4_2025', template: 'fact', metric: 'net', window: 'q4-2025', shape: 'scalar',
    phrasings: [
      'Total net sales for Q4 2025?',
      'What net revenue did we make in the last quarter of 2025?',
    ],
  },
  {
    intentId: 'total_net_sales_2025', template: 'fact', metric: 'net', window: 'y2025', shape: 'scalar',
    phrasings: [
      'What were our net sales for the whole of 2025?',
      'Total net revenue in calendar year 2025.',
    ],
  },
  {
    intentId: 'total_net_sales_feb15_mar15_2026', template: 'fact', metric: 'net', window: 'feb15-mar15', shape: 'scalar',
    phrasings: [
      'What was our turnover from 15 February 2026 through 15 March 2026, both days included?',
      'Net takings between Feb 15 and Mar 15, 2026 (inclusive).',
    ],
  },
  {
    intentId: 'net_sales_monthly_q1_2026', template: 'fact', metric: 'net', window: 'q1-2026', series: true,
    phrasings: [
      'Show turnover month by month for Q1 2026.',
      'Monthly net takings for January to March 2026.',
    ],
  },
  {
    intentId: 'net_sales_monthly_nov_2025_feb_2026', template: 'fact', metric: 'net', window: 'nov25-feb26', series: true,
    phrasings: [
      'Turnover per month from November 2025 through February 2026.',
      'How did monthly takings, net of tax, develop between November 2025 and February 2026?',
    ],
  },
  {
    intentId: 'net_sales_by_year', template: 'net_sales_by_year', shape: 'breakdown', metric: 'net',
    comparison: { mode: 'rowset', compare_columns: ['sales_year', 'total_net_amount'], decimals: 2 },
    mutants: ['cancel', 'metric', 'grain'],
    phrasings: [
      'Net sales by year.',
      'Show total net revenue per calendar year.',
    ],
  },
  {
    intentId: 'customer_net_sales_q1_2025_vs_q1_2026', template: 'pivot', metric: 'net', dim: 'customer', windows: ['q1-2025', 'q1-2026'],
    columns: ['q1_2025_net_amount', 'q1_2026_net_amount'],
    phrasings: [
      'Compare net sales by customer for Q1 2025 and Q1 2026 in two columns.',
      'For each customer, show first-quarter 2025 net revenue next to first-quarter 2026 net revenue.',
    ],
  },
  {
    intentId: 'net_sales_march_2025_vs_march_2026', template: 'pivot', metric: 'net', windows: ['2025-03', '2026-03'],
    columns: ['mar_2025_net_amount', 'mar_2026_net_amount'],
    phrasings: [
      'Show March 2025 and March 2026 turnover side by side.',
      'Put total net takings for March 2025 next to March 2026 in one row.',
    ],
  },
  {
    intentId: 'customer_net_sales_north_warehouse_q1_2026', template: 'fact', metric: 'net', dims: ['customer'], window: 'q1-2026', shape: 'breakdown',
    filters: [{ dim: 'store', value: 'North Warehouse' }],
    phrasings: [
      'Net sales per customer at the North Warehouse in Q1 2026.',
      'For the North Warehouse location, how much net revenue came from each customer in January–March 2026?',
    ],
  },
  {
    intentId: 'net_sales_south_store_mar_2026', template: 'fact', metric: 'net', window: '2026-03', shape: 'scalar',
    filters: [{ dim: 'store', value: 'South Store' }],
    phrasings: [
      'What was turnover at the South Store in March 2026?',
      'How much did South Store take in March 2026, net of tax?',
    ],
  },
  {
    intentId: 'customer_net_sales_sales_invoices_mar_2026', template: 'fact', metric: 'net', dims: ['customer'], window: '2026-03', shape: 'breakdown',
    filters: [{ dim: 'doctype', value: 'Sales Invoice' }],
    phrasings: [
      'Net sales per customer from Sales Invoice documents in March 2026.',
      'Counting only documents of type Sales Invoice, what did each customer buy (net) in March 2026?',
    ],
  },
  {
    intentId: 'net_sales_online_orders_monthly_2026', template: 'fact', metric: 'net', window: 'y2026', series: true,
    filters: [{ dim: 'doctype', value: 'Online Order' }],
    phrasings: [
      'Monthly net sales from Online Order documents in 2026.',
      'How much net revenue came in through online orders each month of 2026?',
    ],
  },
  {
    intentId: 'net_sales_metro_online_store_q1_2026', template: 'fact', metric: 'net', window: 'q1-2026', shape: 'scalar',
    filters: [{ dim: 'customer', value: 'Metro Online Store' }],
    phrasings: [
      'How much did Metro Online Store buy from us (net) in Q1 2026?',
      'Turnover from Metro Online Store for the first quarter of 2026.',
    ],
  },
  {
    intentId: 'net_sales_by_customer_and_store_mar_2026', template: 'fact', metric: 'net', dims: ['customer', 'store'], window: '2026-03', shape: 'breakdown',
    phrasings: [
      'Turnover by customer and store location for March 2026.',
      'Split March 2026 net takings by customer and by the location that served them.',
    ],
  },
  {
    intentId: 'customer_net_sales_top3_jan_2026', template: 'fact', metric: 'net', dims: ['customer'], window: '2026-01', shape: 'top', limit: 3,
    phrasings: [
      'Top 3 customers by net sales for January 2026.',
      'Which three customers spent the most with us, net of tax, in January 2026?',
    ],
  },
  // ---- gross amount ----
  {
    intentId: 'customer_gross_top3_apr_2026', template: 'fact', metric: 'gross', dims: ['customer'], window: '2026-04', shape: 'top', limit: 3,
    phrasings: [
      'Top 3 customers by gross amount in April 2026.',
      'Which three customers had the highest gross sales, tax included, in April 2026?',
    ],
  },
  {
    intentId: 'total_gross_q1_2026', template: 'fact', metric: 'gross', window: 'q1-2026', shape: 'scalar',
    phrasings: [
      'What was the total gross amount for Q1 2026?',
      'Gross sales including tax for the first quarter of 2026.',
    ],
  },
  {
    intentId: 'store_gross_feb_2026', template: 'fact', metric: 'gross', dims: ['store'], window: '2026-02', shape: 'breakdown',
    phrasings: [
      'Gross amount by store location for February 2026.',
      'How much gross turnover (incl. tax) did each store record in February 2026?',
    ],
  },
  {
    intentId: 'gross_monthly_2025', template: 'fact', metric: 'gross', window: 'y2025', series: true,
    phrasings: [
      'Monthly gross amount in 2025.',
      'Show 2025 gross sales by month.',
    ],
  },
  {
    intentId: 'doctype_gross_dec_2025', template: 'fact', metric: 'gross', dims: ['doctype'], window: '2025-12', shape: 'breakdown',
    phrasings: [
      'Gross amount by document type in December 2025.',
      'For December 2025, what was the gross value of each type of document?',
    ],
  },
  // ---- line-level net sales ----
  {
    intentId: 'product_net_sales_top5_feb_2026', template: 'fact', metric: 'line_net', dims: ['product'], window: '2026-02', shape: 'top', limit: 5,
    phrasings: [
      'Top 5 products by net sales in February 2026.',
      'Which five items earned the most revenue in February 2026?',
    ],
  },
  {
    intentId: 'product_net_sales_top5_q1_2026', template: 'fact', metric: 'line_net', dims: ['product'], window: 'q1-2026', shape: 'top', limit: 5,
    phrasings: [
      'Best five products by net revenue across Q1 2026.',
      'What were our top 5 products by net sales in the first quarter of 2026?',
    ],
  },
  {
    intentId: 'product_net_sales_rank_dec_2025', template: 'fact', metric: 'line_net', dims: ['product'], window: '2025-12', shape: 'rank',
    phrasings: [
      'Rank products by turnover for December 2025.',
      'Order every product we sold in December 2025 by its net takings, highest first.',
    ],
  },
  {
    intentId: 'brand_net_sales_feb_2026', template: 'fact', metric: 'line_net', dims: ['brand'], window: '2026-02', shape: 'breakdown',
    phrasings: [
      'Net sales by brand for February 2026.',
      'How much revenue did each brand bring in during February 2026?',
    ],
  },
  {
    intentId: 'brand_net_sales_top3_q1_2026', template: 'fact', metric: 'line_net', dims: ['brand'], window: 'q1-2026', shape: 'top', limit: 3,
    phrasings: [
      'Top 3 brands by turnover in Q1 2026.',
      'Which three brands brought in the most money, net of tax, from January to March 2026?',
    ],
  },
  {
    intentId: 'sunvale_net_sales_monthly_q1_2026', template: 'fact', metric: 'line_net', window: 'q1-2026', series: true,
    filters: [{ dim: 'brand', value: 'Sunvale Foods' }],
    phrasings: [
      'Monthly net sales of Sunvale Foods products in Q1 2026.',
      'How did Sunvale Foods revenue develop month by month in the first quarter of 2026?',
    ],
  },
  {
    intentId: 'category_net_sales_apr_2026', template: 'fact', metric: 'line_net', dims: ['category'], window: '2026-04', shape: 'breakdown',
    phrasings: [
      'Turnover by category in April 2026.',
      'Net takings per category for April 2026.',
    ],
  },
  {
    intentId: 'category_net_sales_top2_nov_2025', template: 'fact', metric: 'line_net', dims: ['category'], window: '2025-11', shape: 'top', limit: 2,
    phrasings: [
      'Which two categories had the highest net sales in November 2025?',
      'Top 2 departments by net revenue, November 2025.',
    ],
  },
  {
    intentId: 'category_net_sales_q1_2025', template: 'fact', metric: 'line_net', dims: ['category'], window: 'q1-2025', shape: 'breakdown',
    phrasings: [
      'Turnover by category in Q1 2025.',
      'Break down first-quarter 2025 net takings by category.',
    ],
  },
  {
    intentId: 'campaign_net_sales_q1_2026', template: 'fact', metric: 'line_net', dims: ['campaign'], window: 'q1-2026', shape: 'breakdown',
    phrasings: [
      'Turnover by campaign for Q1 2026.',
      'How much did each promotion take in, net of tax, in January–March 2026?',
    ],
  },
  {
    intentId: 'weekend_pantry_net_sales_monthly_q1_2026', template: 'fact', metric: 'line_net', window: 'q1-2026', series: true,
    filters: [{ dim: 'campaign', value: 'Weekend Pantry' }],
    phrasings: [
      'Monthly net sales for the Weekend Pantry campaign in Q1 2026.',
      'Show Weekend Pantry promotion revenue for each month of the first quarter of 2026.',
    ],
  },
  {
    intentId: 'product_net_sales_top5_online_fulfillment_mar_2026', template: 'fact', metric: 'line_net', dims: ['product'], window: '2026-03', shape: 'top', limit: 5,
    filters: [{ dim: 'store', value: 'Online Fulfillment' }],
    phrasings: [
      'Top 5 products by net sales at the Online Fulfillment location in March 2026.',
      'Which five products earned the most revenue through Online Fulfillment in March 2026?',
    ],
  },
  {
    intentId: 'brand_net_sales_lakeside_q1_2026', template: 'fact', metric: 'line_net', dims: ['brand'], window: 'q1-2026', shape: 'breakdown',
    filters: [{ dim: 'customer', value: 'Lakeside Wholesale' }],
    phrasings: [
      'Net sales by brand for Lakeside Wholesale in Q1 2026.',
      'Which brands did Lakeside Wholesale buy in the first quarter of 2026, and for how much revenue each?',
    ],
  },
  {
    intentId: 'category_net_sales_by_store_mar_2026', template: 'fact', metric: 'line_net', dims: ['category', 'store'], window: '2026-03', shape: 'breakdown',
    phrasings: [
      'Net sales by product category and store location in March 2026.',
      'For March 2026, show revenue for each category and store combination that had sales.',
    ],
  },
  {
    intentId: 'household_net_sales_feb_2026', template: 'fact', metric: 'line_net', window: '2026-02', shape: 'scalar',
    filters: [{ dim: 'category', value: 'Household' }],
    phrasings: [
      'What were net sales of Household products in February 2026?',
      'How much Household category revenue did we make in February 2026?',
    ],
  },
  {
    intentId: 'herbal_tea_net_sales_monthly_nov_2025_feb_2026', template: 'fact', metric: 'line_net', window: 'nov25-feb26', series: true,
    filters: [{ dim: 'product', value: 'Herbal Tea Variety Pack' }],
    phrasings: [
      'Monthly turnover of Herbal Tea Variety Pack from November 2025 to February 2026.',
      'How much did the Herbal Tea Variety Pack take, net of tax, in each month between November 2025 and February 2026?',
    ],
  },
  // ---- quantity ----
  {
    intentId: 'product_qty_top5_feb_2026', template: 'fact', metric: 'qty', dims: ['product'], window: '2026-02', shape: 'top', limit: 5,
    phrasings: [
      'Top 5 products by quantity sold in February 2026.',
      'Which five SKUs moved the most units in February 2026?',
    ],
  },
  {
    intentId: 'product_qty_top3_apr_2026', template: 'fact', metric: 'qty', dims: ['product'], window: '2026-04', shape: 'top', limit: 3,
    phrasings: [
      'Top 3 items by units in April 2026.',
      'Which three products sold the highest number of units in April 2026?',
    ],
  },
  {
    intentId: 'product_qty_top3_jan_2026', template: 'fact', metric: 'qty', dims: ['product'], window: '2026-01', shape: 'top', limit: 3,
    phrasings: [
      'Which three products sold the most units in January 2026?',
      'Top 3 products by quantity sold, January 2026.',
    ],
  },
  {
    intentId: 'brand_qty_q1_2026', template: 'fact', metric: 'qty', dims: ['brand'], window: 'q1-2026', shape: 'breakdown',
    phrasings: [
      'Units sold by brand in Q1 2026.',
      'How many units of each brand did we sell between January and March 2026?',
    ],
  },
  {
    intentId: 'category_qty_feb_2026', template: 'fact', metric: 'qty', dims: ['category'], window: '2026-02', shape: 'breakdown',
    phrasings: [
      'Quantity sold per product category in February 2026.',
      'How many units did each category sell in February 2026?',
    ],
  },
  {
    intentId: 'campaign_qty_mar_2026', template: 'fact', metric: 'qty', dims: ['campaign'], window: '2026-03', shape: 'breakdown',
    phrasings: [
      'Units sold per campaign in March 2026.',
      'How many units did each promotion move in March 2026?',
    ],
  },
  {
    intentId: 'kitchen_towels_qty_q1_2026', template: 'fact', metric: 'qty', window: 'q1-2026', shape: 'scalar',
    filters: [{ dim: 'product', value: 'Kitchen Towels 4 Roll' }],
    phrasings: [
      'How many units of Kitchen Towels 4 Roll did we sell in Q1 2026?',
      'Total quantity of Kitchen Towels 4 Roll sold in the first quarter of 2026.',
    ],
  },
  {
    intentId: 'cane_sugar_qty_monthly_q1_2026', template: 'fact', metric: 'qty', window: 'q1-2026', series: true,
    filters: [{ dim: 'product', value: 'Cane Sugar 2kg' }],
    phrasings: [
      'Monthly quantity of Cane Sugar 2kg sold in Q1 2026.',
      'How many units of Cane Sugar 2kg did we sell in each month of Q1 2026?',
    ],
  },
  {
    intentId: 'store_qty_mar_2026', template: 'fact', metric: 'qty', dims: ['store'], window: '2026-03', shape: 'breakdown',
    phrasings: [
      'Units per store location in March 2026.',
      'How many units left each of our locations in March 2026?',
    ],
  },
  {
    intentId: 'customer_qty_top3_q1_2026', template: 'fact', metric: 'qty', dims: ['customer'], window: 'q1-2026', shape: 'top', limit: 3,
    phrasings: [
      'Which three customers bought the most units in Q1 2026?',
      'Top 3 customers by quantity purchased, January–March 2026.',
    ],
  },
  {
    intentId: 'total_qty_dec_2025', template: 'fact', metric: 'qty', window: '2025-12', shape: 'scalar',
    phrasings: [
      'How many units did we sell in total in December 2025?',
      'Total quantity sold across all products in December 2025.',
    ],
  },
  // ---- document counts ----
  {
    intentId: 'store_document_count_q1_2026', template: 'fact', metric: 'docs', dims: ['store'], window: 'q1-2026', shape: 'breakdown',
    phrasings: [
      'Number of documents per store location in Q1 2026.',
      'How many documents came from each store in January–March 2026?',
    ],
  },
  {
    intentId: 'document_count_may_2026', template: 'fact', metric: 'docs', window: '2026-05', shape: 'scalar',
    phrasings: [
      'How many documents did we have in May 2026?',
      'Number of documents dated May 2026.',
    ],
  },
  {
    intentId: 'document_count_monthly_2026', template: 'fact', metric: 'docs', window: 'y2026', series: true,
    phrasings: [
      'Number of documents by month for 2026.',
      'How many documents did we record in each month of 2026?',
    ],
  },
  {
    intentId: 'doctype_document_count_q1_2026', template: 'fact', metric: 'docs', dims: ['doctype'], window: 'q1-2026', shape: 'breakdown',
    phrasings: [
      'How many documents of each document type were there in Q1 2026?',
      'Count first-quarter 2026 documents by type of document.',
    ],
  },
  {
    intentId: 'store_receipt_count_2026', template: 'fact', metric: 'docs', window: 'y2026', shape: 'scalar',
    filters: [{ dim: 'doctype', value: 'Store Receipt' }],
    phrasings: [
      'How many store receipts were there in 2026?',
      'Number of Store Receipt documents dated in 2026.',
    ],
  },
  {
    intentId: 'north_district_document_count_q1_2026', template: 'fact', metric: 'docs', window: 'q1-2026', shape: 'scalar', boundary: 'end',
    filters: [{ dim: 'customer', value: 'North District Market' }],
    phrasings: [
      'How many documents did North District Market have in Q1 2026?',
      'Number of sales documents for North District Market between January and March 2026.',
    ],
  },
  {
    intentId: 'document_count_mar01_10_2026', template: 'fact', metric: 'docs', window: 'mar01-10', shape: 'scalar',
    phrasings: [
      'How many sales documents were dated between 1 and 10 March 2026, inclusive?',
      'Count the documents from March 1 to March 10, 2026 (both days included).',
    ],
  },
  {
    intentId: 'documents_posted_feb_2026', template: 'fact', metric: 'docs', window: '2026-02', shape: 'scalar', dateColumn: 'PostingDate',
    failure_class: 'wrong_date_column',
    phrasings: [
      'How many documents have a posting date in February 2026?',
      'Count the documents whose posting date falls in February 2026.',
    ],
  },
  {
    intentId: 'documents_due_apr_2026', template: 'fact', metric: 'docs', window: '2026-04', shape: 'scalar', dateColumn: 'DueDate',
    failure_class: 'wrong_date_column',
    phrasings: [
      'How many documents fall due in April 2026?',
      'Number of documents with a due date in April 2026.',
    ],
  },
  // ---- distinct buying customers ----
  {
    intentId: 'distinct_customers_feb_2026', template: 'fact', metric: 'customers', window: '2026-02', shape: 'scalar',
    phrasings: [
      'How many different customers bought from us in February 2026?',
      'Number of unique buying customers in February 2026.',
    ],
  },
  {
    intentId: 'store_distinct_customers_q1_2026', template: 'fact', metric: 'customers', dims: ['store'], window: 'q1-2026', shape: 'breakdown',
    phrasings: [
      'How many distinct customers did each store serve in Q1 2026?',
      'Unique customers per store location, January to March 2026.',
    ],
  },
  {
    intentId: 'distinct_customers_monthly_q1_2026', template: 'fact', metric: 'customers', window: 'q1-2026', series: true,
    phrasings: [
      'Unique customers per month in Q1 2026.',
      'How many different customers bought in each month of the first quarter of 2026?',
    ],
  },
  {
    intentId: 'category_distinct_customers_mar_2026', template: 'fact', metric: 'customers', dims: ['category'], window: '2026-03', shape: 'breakdown',
    phrasings: [
      'How many different customers bought each category in March 2026?',
      'For March 2026, count the distinct buyers of every category.',
    ],
  },
  {
    intentId: 'urban_refresh_customers_q1_2026', template: 'fact', metric: 'customers', window: 'q1-2026', shape: 'scalar',
    filters: [{ dim: 'campaign', value: 'Urban Refresh' }],
    phrasings: [
      'How many customers bought Urban Refresh campaign products in Q1 2026?',
      'Number of distinct customers who purchased anything from the Urban Refresh promotion in January–March 2026.',
    ],
  },
  {
    intentId: 'distinct_customers_2025', template: 'fact', metric: 'customers', window: 'y2025', shape: 'scalar',
    phrasings: [
      'How many distinct customers did we sell to in 2025?',
      'Count the unique customers with at least one purchase in calendar 2025.',
    ],
  },
  // ---- average order value ----
  {
    intentId: 'average_order_value_mar_2026', template: 'fact', metric: 'aov', window: '2026-03', shape: 'scalar',
    phrasings: [
      'What was the average order value in March 2026?',
      'Average net value per sales document in March 2026.',
    ],
  },
  {
    intentId: 'store_average_order_value_q1_2026', template: 'fact', metric: 'aov', dims: ['store'], window: 'q1-2026', shape: 'breakdown',
    phrasings: [
      'Average order value by store location in Q1 2026.',
      'What was the average net amount per document at each store from January to March 2026?',
    ],
  },
  {
    intentId: 'average_order_value_monthly_q1_2026', template: 'fact', metric: 'aov', window: 'q1-2026', series: true,
    phrasings: [
      'Average order value per month in Q1 2026.',
      'How did the average net ticket size change month by month in the first quarter of 2026?',
    ],
  },
  {
    intentId: 'doctype_average_order_value_feb_2026', template: 'fact', metric: 'aov', dims: ['doctype'], window: '2026-02', shape: 'breakdown',
    phrasings: [
      'Average net amount per document by document type in February 2026.',
      'For each type of document, what was the average net value in February 2026?',
    ],
  },
  {
    intentId: 'customer_average_order_value_top3_q1_2026', template: 'fact', metric: 'aov', dims: ['customer'], window: 'q1-2026', shape: 'top', limit: 3,
    phrasings: [
      'Which three customers had the highest average order value in Q1 2026?',
      'Top 3 customers by average net value per document, January–March 2026.',
    ],
  },
  // ---- outstanding balance and payments ----
  {
    intentId: 'outstanding_balance_mar_2026', template: 'fact', metric: 'balance', window: '2026-03', shape: 'scalar',
    phrasings: [
      'What is the total outstanding balance on documents dated March 2026?',
      'How much is still unpaid on March 2026 sales?',
    ],
  },
  {
    intentId: 'store_outstanding_balance_q1_2026', template: 'fact', metric: 'balance', dims: ['store'], window: 'q1-2026', shape: 'breakdown',
    phrasings: [
      'Outstanding balance by store location for Q1 2026 documents.',
      'For documents dated January to March 2026, how much remains unpaid at each store?',
    ],
  },
  {
    intentId: 'outstanding_balance_due_apr_2026', template: 'fact', metric: 'balance', window: '2026-04', shape: 'scalar', dateColumn: 'DueDate',
    // The error analysis (Experiment 1) found the trap is the amount ("open
    // amount", "unpaid balance": BalanceAmount), not the due date.
    failure_class: 'metric_column_confusion',
    phrasings: [
      'How much unpaid balance falls due in April 2026?',
      'Total open amount on documents with a due date in April 2026.',
    ],
  },
  {
    intentId: 'doctype_outstanding_balance_feb_2026', template: 'fact', metric: 'balance', dims: ['doctype'], window: '2026-02', shape: 'breakdown',
    phrasings: [
      'Open balance by document type for February 2026.',
      'How much is still owed on February 2026 documents, split by type of document?',
    ],
  },
  {
    intentId: 'outstanding_balance_monthly_q1_2026', template: 'fact', metric: 'balance', window: 'q1-2026', series: true,
    phrasings: [
      'Outstanding balance by document month for Q1 2026.',
      'For each month of Q1 2026, how much of that month’s sales is still unpaid?',
    ],
  },
  {
    intentId: 'paid_amount_mar_2026', template: 'fact', metric: 'paid', window: '2026-03', shape: 'scalar',
    phrasings: [
      'How much has been paid on documents dated March 2026?',
      'Total payments received against March 2026 sales.',
    ],
  },
  // ---- ledger ----
  {
    intentId: 'account_debit_credit_q1_2026', template: 'ledger', measures: ['debit', 'credit'], window: 'q1-2026', dateMode: 'document',
    phrasings: [
      'Debit and credit totals by account name for sales dated in Q1 2026.',
      'For sales dated January to March 2026, list each account by name with its total debits and credits.',
    ],
  },
  {
    intentId: 'account_debit_credit_posted_apr_2026', template: 'ledger', measures: ['debit', 'credit'], window: '2026-04', dateMode: 'posting',
    // The trap the error analysis found: an inner join to SalesDocument drops
    // the April manual journals (the posting date itself is not ambiguous).
    failure_class: 'wrong_join_path',
    phrasings: [
      'List each account by name with its debits and credits for postings dated April 2026.',
      'Using the posting date, what were the total debits and credits on each account in April 2026? Show the account names.',
    ],
  },
  {
    intentId: 'account_net_movement_feb_2026', template: 'ledger', measures: ['net_movement'], window: '2026-02', dateMode: 'document',
    phrasings: [
      'Net movement (debits minus credits) per ledger account name for February 2026 sales documents.',
      'For each account, by name, what is debit minus credit on postings of sales dated February 2026?',
    ],
  },
  {
    intentId: 'revenue_credits_monthly_q1_2026', template: 'ledger', measures: ['credit'], window: 'q1-2026', dateMode: 'posting', accountCode: '4000', series: true,
    phrasings: [
      { q: 'Monthly credits posted to account 4000 (Sales Revenue) in Q1 2026.', knownRejection: 'METRIC_COLUMN' },
      'How much was credited to ledger 4000 in each month of the first quarter of 2026, by posting date?',
    ],
  },
  {
    intentId: 'receivable_debits_posted_mar_2026', template: 'ledger', measures: ['debit'], window: '2026-03', dateMode: 'posting', accountCode: '1100',
    phrasings: [
      'Total debits posted to account 1100 in March 2026.',
      'What was debited to ledger account 1100 by postings dated March 2026?',
    ],
  },
  {
    intentId: 'manual_journal_debits_2026', template: 'ledger', measures: ['debit'], window: 'y2026', dateMode: 'posting', manualOnly: true,
    phrasings: [
      'How much was debited in manual journal postings (not linked to any sales document) in 2026?',
      'Total debits of 2026 postings that have no sales document attached.',
    ],
  },
  {
    intentId: 'account_posting_count_mar_2026', template: 'ledger', measures: ['postings'], window: '2026-03', dateMode: 'posting',
    phrasings: [
      'How many postings hit each ledger account in March 2026 (by posting date)? Name the accounts.',
      'Count the journal lines per account name posted in March 2026.',
    ],
  },
  // ---- other shapes ----
  {
    intentId: 'active_customers_without_sales_q1_2026', template: 'active_customers_without_sales', window: 'q1-2026', shape: 'breakdown', boundary: 'end',
    // The cancel filter inside the anti-join (a canceled Q1 sale is no sale).
    failure_class: 'default_filter',
    comparison: { mode: 'rowset', compare_columns: ['CustomerName'] },
    mutants: ['cancel', 'date_col', 'date_boundary', 'date_boundary_other', 'active'],
    difficulty: 'hard', tags: ['anti_join'],
    phrasings: [
      'Which active customers had no sales in Q1 2026?',
      'List active customers who did not buy anything between January and March 2026.',
    ],
  },
  {
    intentId: 'customers_bought_feb_not_mar_2026', template: 'customers_lost_between', windows: ['2026-02', '2026-03'], shape: 'scalar',
    // "How many": one count, not the list of customers.
    failure_class: 'aggregation_shape',
    comparison: { mode: 'scalar' },
    mutants: ['cancel', 'cancel_first', 'cancel_second', 'count_docs', 'date_col', 'date_boundary', 'date_boundary_other'],
    notEmitted: {
      count:
        "COUNT(*) over the first month's SELECT DISTINCT set equals COUNT(DISTINCT CustomerId): the CTE already yields distinct customers (forgetting that DISTINCT is the count control)",
      group_by:
        'COUNT(DISTINCT CustomerName), which merges the two Summit Grocers: fixture limit, both namesakes buy in March 2026 on v2 and v3 (and only C-005 trades on seed), so no fixture can separate it without removing designed March rows (a known blind spot)',
    },
    difficulty: 'hard', tags: ['anti_join', 'comparison'],
    phrasings: [
      'How many customers bought in February 2026 but not in March 2026?',
      'Count the customers with a February 2026 purchase and none in March 2026.',
    ],
  },
  {
    intentId: 'last_purchase_date_by_customer', template: 'last_purchase_date', shape: 'breakdown',
    comparison: { mode: 'rowset', compare_columns: ['CustomerName', 'last_purchase_date'] },
    mutants: ['cancel', 'date_col', 'min', 'group_by'],
    tags: ['customer', 'date'],
    phrasings: [
      'What was the most recent purchase date for each customer?',
      'When did each customer last buy from us?',
    ],
  },
  {
    intentId: 'largest_document_mar_2026', template: 'largest_document', window: '2026-03', shape: 'top',
    comparison: { mode: 'rowset', compare_columns: ['DocumentNo', 'net_amount'], decimals: 2 },
    mutants: ['cancel', 'date_col', 'date_boundary', 'date_boundary_other', 'metric', 'order'],
    heldoutMutants: ['order_gross'],
    tags: ['sales_document', 'ranking'],
    phrasings: [
      'Which sales document had the highest net amount in March 2026, and what was that amount?',
      'What was our single biggest document by net value in March 2026, and its number?',
    ],
  },
  {
    intentId: 'canceled_document_count_q1_2026', template: 'canceled_documents', window: 'q1-2026', shape: 'scalar',
    comparison: { mode: 'scalar' },
    mutants: ['cancel_inverted', 'cancel_dropped', 'date_col', 'date_boundary', 'date_boundary_other'],
    tags: ['sales_document', 'canceled', 'count'],
    phrasings: [
      'How many sales documents were canceled in Q1 2026?',
      'Count the canceled documents dated January to March 2026.',
    ],
  },
  {
    intentId: 'store_canceled_value_q1_2026', template: 'canceled_documents', window: 'q1-2026', shape: 'breakdown', dim: 'store', withValue: true,
    comparison: { mode: 'rowset', compare_columns: ['LocationName', 'document_count', 'canceled_net_amount'], decimals: 2 },
    mutants: ['cancel_inverted', 'date_col', 'date_boundary', 'date_boundary_other', 'metric'],
    tags: ['sales_document', 'canceled', 'store_location'],
    phrasings: [
      'Number and net value of canceled documents by store location in Q1 2026.',
      'For each store, how many documents were canceled between January and March 2026 and what were they worth (net)?',
    ],
  },
];

export const INTENT_CATALOGUE = INTENTS;

// Per-intent mutation families that are not emitted, with the reason: the
// mutant cannot change this intent's answer (semantically equivalent here), or
// a documented fixture limit (no fixture row separates it, and adding one
// would break another designed property). Keys are `<type>:<note>` of the
// mutant. Template-wide rules live in mutationsFor and are recorded the same
// way in the controls file (`not_emitted`).
// The note of the 'end' off-by-one mutant (BOUNDARY_NOTES.end, defined with the mutants).
const DAY_AFTER = 'day after the window included (<= instead of <)';
const NO_JUNE_2026 =
  'fixture limit: no fixture has a document on 2026-06-01, and June 2026 must stay empty on every fixture (the zero-row case hard_zero_customers_jun_2026)';
const NO_2027 =
  'fixture limit: no fixture has data after May 2026, so nothing is dated 2027-01-01 (a future-dated document would leak into every all-time question)';
export const NOT_EMITTED = {
  doctype_net_sales_top1_may_2026: { [`date_boundary:${DAY_AFTER}`]: NO_JUNE_2026 },
  document_count_may_2026: { [`date_boundary:${DAY_AFTER}`]: NO_JUNE_2026 },
  net_sales_online_orders_monthly_2026: { [`date_boundary:${DAY_AFTER}`]: NO_2027 },
  document_count_monthly_2026: { [`date_boundary:${DAY_AFTER}`]: NO_2027 },
  store_receipt_count_2026: { [`date_boundary:${DAY_AFTER}`]: NO_2027 },
  manual_journal_debits_2026: { [`date_boundary:${DAY_AFTER}`]: NO_2027 },
  household_net_sales_feb_2026: {
    [`date_boundary:${DAY_AFTER}`]:
      "fixture limit: no Household line is dated 2026-03-01: v2 cannot sell a tenth product in non-canceled March 2026 (the top-10 LEFT JOIN rule of core_public_002), and v3's March totals are held by its customer tie and top-10 cut-off",
  },
  active_customers_without_sales_q1_2026: {
    'date_boundary:first day of the window excluded (> instead of >=)':
      'fixture limit: every active customer with a Q1 2026 sale on v2 and v3 also buys after 1 January, and seed has no 1 January document; making 1 January some customer\'s only Q1 sale would undo the rows the other controls of this intent need',
  },
};

// Positive controls for a sample of intents: every POSITIVE_EVERY-th intent
// of the fact and ledger templates, rotating CTE / derived table / alias.
const POSITIVE_EVERY = 3;

// --- gold, alternatives, comparison ----------------------------------------------------

function buildQuery(intent, m = {}) {
  switch (intent.template) {
    case 'fact':
      return factQuery(intent, m);
    case 'pivot':
      return pivotQuery(intent, m);
    case 'ledger':
      return ledgerQuery(intent, m);
    default:
      if (!CUSTOM[intent.template]) {
        throw new Error(`${intent.intentId}: unknown template ${intent.template}`);
      }
      return CUSTOM[intent.template](intent, m);
  }
}

function metricOf(intent) {
  return intent.metric ? METRICS[intent.metric] : null;
}

// True for a quantity intent without a product, brand, category or campaign
// dimension or filter: its gold leaves out the delivery-fee lines explicitly
// (l.ProductId IS NOT NULL), so dropping that filter counts them as units.
function unitsNeedProductJoinOnly(intent) {
  const lineDims = [...(intent.dims || []), ...(intent.filters || []).map((filter) => filter.dim)].filter((dim) => DIMS[dim].grain === 'line');
  return intent.template === 'fact' && intent.metric === 'qty' && lineDims.length === 0;
}

function seriesLabels(intent) {
  return ['ymd', 'num', ...(windowSpansYears(WINDOWS[intent.window]) ? [] : ['name']), 'abbrYear', 'nameYear'];
}

function alternativesFor(intent) {
  const alternatives = [];
  if (intent.series) {
    for (const monthLabel of seriesLabels(intent)) {
      alternatives.push(buildQuery(intent, { monthLabel }));
    }
  }
  if (intent.template === 'pivot' && intent.dim === 'customer') {
    alternatives.push(pivotQuery(intent, { everyCustomer: true }));
  }
  // Manual journals have no sales document, so leaving out the postings of
  // canceled documents changes nothing there (no alternative).
  if (intent.template === 'ledger' && intent.dateMode === 'posting' && !intent.manualOnly) {
    alternatives.push(ledgerQuery(intent, { leftJoinCancel: true }));
  }
  if (intent.template === 'last_purchase_date') {
    alternatives.push(CUSTOM.last_purchase_date(intent, { everyCustomer: true }));
  }
  return alternatives;
}

function notesFor(intent) {
  const notes = [];
  if (intent.series) {
    const spans = windowSpansYears(WINDOWS[intent.window]);
    notes.push(
      'A month can be labelled several ways; alternative_expected_sql accepts the same series labelled ' +
        `'YYYY-MM-01', with the month number${spans ? '' : ', with the month name'}, as 'Jan 2026' or as 'January 2026' (the gold uses 'YYYY-MM').`
    );
  }
  if (intent.template === 'pivot' && intent.dim === 'customer') {
    notes.push(
      'Two readings are accepted: the gold lists the customers with a non-canceled document in either window; alternative_expected_sql lists every customer (LEFT JOIN from Customer) with 0 where it had none. column_order keeps the earlier window first unless the columns are named like the gold columns; null_as_zero accepts NULL for a window without sales. Scoring relaxation ignore_all_zero_rows: any other listing that adds customers with 0 (or NULL) in both windows, such as every customer that bought at any time, is the same answer.'
    );
  } else if (intent.template === 'pivot') {
    notes.push('column_order keeps the earlier window first unless the columns are named like the gold columns.');
  }
  if (intent.template === 'ledger' && intent.manualOnly) {
    notes.push(
      'Manual journals are the postings with no sales document (AccountingPosting.SalesDocumentId IS NULL), selected by PostingDate; the answer is one total over every account.'
    );
  } else if (intent.template === 'ledger' && intent.dateMode === 'posting') {
    notes.push(
      'Ledger postings selected by AccountingPosting.PostingDate. Two readings are accepted: every posting in the window, manual journals included (the gold), and the same without the postings of canceled sales documents (alternative_expected_sql: LEFT JOIN SalesDocument with the cancel filter, which keeps manual journals).'
    );
  }
  if (intent.template === 'ledger' && intent.dateMode === 'document') {
    notes.push('Postings of non-canceled sales documents dated in the window (SalesDocument.DocumentDate), the convention of the core ledger cases.');
  }
  if (intent.template === 'ledger' && !intent.accountCode && !intent.manualOnly && !intent.series) {
    notes.push('Rows are compared on the account name and the amounts (the code may be left out; an answer listing only codes fails, so the questions ask for the account names).');
  }
  if (unitsNeedProductJoinOnly(intent)) {
    notes.push(
      'Units are product units: the delivery-fee lines (NULL ProductId, Quantity 1) are not units sold, so the gold keeps product lines only (l.ProductId IS NOT NULL; a join to Product is equivalent), like the product-level unit cases.'
    );
  }
  if (intent.template === 'last_purchase_date') {
    notes.push(
      'Two readings are accepted: the customers with at least one non-canceled document (the gold) and every customer, with no date for one that never bought (alternative_expected_sql, LEFT JOIN from Customer). Every document type counts as a purchase, Credit Memos included (the suite-wide convention).'
    );
  }
  const campaignScoped = [...(intent.dims || []), ...(intent.filters || []).map((filter) => filter.dim)].includes('campaign');
  if (campaignScoped) {
    notes.push(
      'Campaign attribution (gold convention): a sale belongs to the campaign of the product sold (Product.CampaignId, on line amounts), as the product prompt rules and semantic layer say; SalesDocument.CampaignId, the campaign a whole document was entered under, is not sales attribution here.'
    );
  }
  if (intent.metric === 'aov') {
    notes.push(
      'Average order value (gold convention): the average header NetAmount per non-canceled document, net of tax like every sales amount in the suite; the billed total (BillTotalAmount) is not accepted.'
    );
  }
  if (intent.shape === 'rank') {
    notes.push('A ranking without a number lists every member (no LIMIT); only "top N" keeps N (gold convention).');
  }
  if (comparisonFor(intent).empty_as_zero) {
    notes.push('Scoring relaxation empty_as_zero: where the window has no rows, an empty result (for example a total grouped by the filtered member) equals the NULL / 0 total.');
  }
  return notes.join(' ');
}

function comparisonFor(intent) {
  if (intent.comparison) {
    return intent.comparison;
  }
  const metric = metricOf(intent);
  const decimals = metric?.decimals ?? null;
  const tolerance = metric?.tolerance ?? 0;
  const base = (mode) => ({
    mode,
    ...(decimals != null ? { decimals } : {}),
    ...(tolerance ? { tolerance } : {}),
  });
  if (intent.template === 'pivot') {
    return {
      mode: 'rowset',
      ...(intent.dim ? { compare_columns: [DIMS[intent.dim].column, ...intent.columns] } : {}),
      decimals: 2,
      column_order: [...intent.columns],
      null_as_zero: [...intent.columns],
      // Scoring relaxation: a customer listed with 0 in both windows is the
      // same answer (the error analysis found models listing every customer
      // with activity at any time).
      ...(intent.dim === 'customer' ? { ignore_all_zero_rows: true } : {}),
    };
  }
  if (intent.template === 'ledger') {
    const aliases = intent.measures.map((name) => LEDGER_MEASURES[name].alias);
    if (intent.series) {
      return { mode: 'rowset', decimals: 2 };
    }
    if (intent.accountCode || intent.manualOnly) {
      // Scoring relaxation: no rows is the same answer as a NULL / 0 total.
      return { mode: 'scalar', decimals: 2, null_as_zero: aliases, empty_as_zero: true };
    }
    return { mode: 'rowset', compare_columns: ['AccountName', ...aliases], decimals: 2 };
  }
  if (intent.series) {
    return base('rowset');
  }
  switch (intent.shape) {
    case 'top':
    case 'rank':
      return { ...base('ranked'), value_columns: [metric.alias], order: 'desc' };
    case 'breakdown':
      return base('rowset');
    case 'scalar':
      // SUM over an empty window is NULL; 0, and (a scoring relaxation) no
      // rows at all, are the same answer.
      return { ...base('scalar'), ...(metric.agg === 'sum' ? { null_as_zero: [metric.alias], empty_as_zero: true } : {}) };
    default:
      throw new Error(`${intent.intentId}: unknown shape ${intent.shape}`);
  }
}

// --- classification ----------------------------------------------------------------------

function windowKind(key) {
  if (!key) {
    return 'all_time';
  }
  if (/^\d{4}-\d{2}$/.test(key)) {
    return 'single_month';
  }
  if (key.startsWith('q')) {
    return 'quarter';
  }
  if (key.startsWith('y')) {
    return 'year';
  }
  return 'date_range';
}

function failureClassFor(intent) {
  if (intent.failure_class !== undefined) {
    return intent.failure_class;
  }
  if (intent.template === 'pivot' || intent.series) {
    return 'aggregation_shape';
  }
  if (intent.template === 'ledger') {
    // By the sales document's date: the postings of non-canceled documents
    // only (the cancel filter through the SalesDocument join).
    return intent.dateMode === 'posting' ? 'wrong_date_column' : 'default_filter';
  }
  // Units are product units: the delivery-fee lines must be left out.
  if (unitsNeedProductJoinOnly(intent)) {
    return 'default_filter';
  }
  const dims = intent.dims || [];
  if (['gross', 'balance', 'paid'].includes(intent.metric)) {
    return 'metric_column_confusion';
  }
  if (intent.metric === 'aov') {
    return 'ratio_metric';
  }
  if (intent.metric === 'customers') {
    return 'distinct_count';
  }
  if (intent.metric === 'line_net' && dims.includes('brand')) {
    return 'wrong_join_path';
  }
  if (intent.metric === 'line_net' && dims.includes('campaign')) {
    return 'campaign_join_path';
  }
  if (intent.metric === 'qty' && (dims.includes('brand') || dims.includes('category'))) {
    return 'stale_snapshot_field';
  }
  if (intent.metric === 'line_net' && (dims.includes('product') || dims.includes('category'))) {
    return 'grain_confusion';
  }
  if ((intent.filters || []).length > 0) {
    return 'entity_filter';
  }
  if (intent.window && windowKind(intent.window) !== 'single_month') {
    return 'time_window';
  }
  return null;
}

function difficultyFor(intent) {
  if (intent.difficulty) {
    return intent.difficulty;
  }
  if (intent.template !== 'fact') {
    return 'hard';
  }
  const metric = metricOf(intent);
  const dims = intent.dims || [];
  const filters = intent.filters || [];
  if (intent.series || dims.length > 1 || metric.grain === 'line' || dims.some((dim) => DIMS[dim].grain === 'line')) {
    return 'hard';
  }
  if (dims.length === 0 && filters.length === 0 && ['net', 'docs', 'gross'].includes(intent.metric) && !intent.dateColumn) {
    return 'easy';
  }
  return 'medium';
}

function tagsFor(intent) {
  const tags = ['templated'];
  const metric = metricOf(intent);
  if (metric) {
    tags.push(...metric.tags);
  }
  if (intent.template === 'ledger') {
    tags.push('accounting', ...intent.measures);
  }
  for (const dim of intent.dims || (intent.dim ? [intent.dim] : [])) {
    tags.push(DIMS[dim].tag);
  }
  for (const filter of intent.filters || []) {
    tags.push(`filter_${DIMS[filter.dim].tag}`);
  }
  if (intent.series) {
    tags.push('time_series');
  } else if (intent.template === 'pivot') {
    tags.push('pivot');
  } else if (intent.shape === 'top' || intent.shape === 'rank') {
    tags.push('ranking');
  } else if (intent.shape === 'scalar') {
    tags.push('scalar');
  } else if (intent.shape === 'breakdown') {
    tags.push('aggregation');
  }
  tags.push(windowKind(intent.window || (intent.windows ? 'range' : null)));
  if (intent.dateColumn) {
    tags.push(intent.dateColumn === 'PostingDate' ? 'posting_date' : 'due_date');
  }
  if (intent.dateMode === 'posting') {
    tags.push('posting_date');
  }
  tags.push(...(intent.tags || []));
  if (wasHoldoutIntent(intent.intentId)) {
    tags.push(FORMERLY_HOLDOUT_TAG);
  }
  return [...new Set(tags)];
}

const TABLE_REFERENCE = /\b(?:FROM|JOIN)\s+([A-Z][A-Za-z]+)\b/g;

function tablesOf(sql) {
  const cteNames = new Set([...sql.matchAll(/(?:WITH|,)\s+([A-Za-z]+)\s+AS\s+\(/g)].map((match) => match[1]));
  return [...new Set([...sql.matchAll(TABLE_REFERENCE)].map((match) => match[1]).filter((name) => !cteNames.has(name)))];
}

// --- negative controls --------------------------------------------------------------------

const BOUNDARY_NOTES = {
  start: 'first day of the window excluded (> instead of >=)',
  end: 'day after the window included (<= instead of <)',
};

// Both off-by-one sides, the window's designated side first (the side every
// fixture separates for that window; the other side may be listed in
// NOT_EMITTED with the fixture limit that lets it survive).
function boundaryMutants(add, designated) {
  for (const side of designated === 'end' ? ['end', 'start'] : ['start', 'end']) {
    add('date_boundary', BOUNDARY_NOTES[side], { boundary: side });
  }
}

// The amount a ranking could wrongly be ordered by while still showing the
// asked metric (held-out family).
const ORDER_SWAPS = {
  net: { column: 'd.GrossAmount', note: 'ranked by the gross amount while showing net' },
  gross: { column: 'd.NetAmount', note: 'ranked by the net amount while showing gross' },
  aov: { column: 'd.GrossAmount', note: 'ranked by the average gross amount while showing the net average' },
  line_net: { column: 'l.TotalAmount', note: 'ranked by line TotalAmount while showing line NetAmount' },
  qty: { column: 'l.NetAmount', note: 'ranked by line net amount while showing units' },
};

/**
 * The negative controls (mutants) for an intent: [{ type, note, m }] for the
 * builder (design controls), the held-out mutants (families the fixtures were
 * not extended against; reported apart and not gated), plus the families
 * deliberately not emitted, with the reason.
 */
function mutationsFor(intent) {
  const mutants = [];
  const heldout = [];
  const skipped = [];
  const add = (type, note, m) => mutants.push({ type, note, m });
  const addHeldout = (type, note, m) => heldout.push({ type, note, m });
  const skip = (type, reason) => skipped.push({ type, reason });
  const window = intent.window ? WINDOWS[intent.window] : null;

  if (intent.template === 'fact') {
    const metric = metricOf(intent);
    const dims = intent.dims || [];
    const filters = intent.filters || [];
    const dateColumn = intent.dateColumn || 'DocumentDate';
    add('cancel', 'canceled documents not excluded', { dropCancel: true });
    if (dateColumn === 'DocumentDate') {
      add('date_col', 'PostingDate instead of DocumentDate', { dateColumn: 'PostingDate' });
    } else {
      add('date_col', `DocumentDate instead of ${dateColumn}`, { dateColumn: 'DocumentDate' });
    }
    boundaryMutants(add, intent.boundary || window.boundary);
    if (window.prior) {
      add('date_filter', 'MONTH() without YEAR(): the same month of the previous year is included', { monthOnly: true });
    }
    if (METRIC_SWAPS[intent.metric]) {
      add('metric', METRIC_SWAPS[intent.metric].note, { metricColumn: METRIC_SWAPS[intent.metric].column });
    }
    if (intent.metric === 'customers') {
      add('count', 'COUNT(*) counts documents (or lines), not distinct customers', { countStar: true });
      add('count', 'COUNT(DISTINCT CustomerName) merges the two customers named Summit Grocers', { distinctNames: true });
    }
    if (intent.metric === 'qty') {
      add('count', 'number of lines instead of the quantity', { countStar: true });
    }
    if (unitsNeedProductJoinOnly(intent)) {
      add('filter', 'the NULL-ProductId delivery-fee lines counted as units (no product filter)', { feeLines: true });
    }
    if (intent.metric === 'docs') {
      skip('count', 'COUNT(*) over SalesDocument counts each document once, the same as COUNT(DISTINCT SalesDocumentId); counting lines is the grain control');
    }
    if (metric.grain === 'header' && ['sum', 'avg', 'count'].includes(metric.agg)) {
      add('grain', `the header ${metric.agg === 'count' ? 'row' : 'amount'} repeated for every line (joined to SalesDocumentLine)`, { fanOut: true });
    }
    if (intent.metric === 'net') {
      add('grain', 'sum of line net amounts instead of the document net amount (misses header discounts and fees)', { lineMetric: true });
    }
    if (intent.metric === 'line_net') {
      add('grain', 'the document net amount summed for every line instead of the line net amount', { headerMetric: 'd.NetAmount' });
    }
    if (metric.agg === 'sum') {
      add('sum_distinct', 'SUM(DISTINCT ...) drops repeated values', { sumDistinct: true });
    }
    if (dims.includes('customer')) {
      add('group_by', 'grouped by CustomerName only: the two customers named Summit Grocers are merged', { groupByName: 'customer' });
    } else if (dims.length > 0) {
      skip('group_by', 'the dimension names are unique, so grouping by the name alone gives the same groups');
    }
    if (dims.length > 1) {
      const [first, second] = dims;
      add('group_by', `the ${second} key dropped from GROUP BY (its name still selected): one arbitrary ${second} per ${first}`, { dropGroupKey: second });
    }
    if (intent.series) {
      add('group_by', 'the month dropped from GROUP BY: one row for the whole window under an arbitrary month label', { dropGroupKey: 'month' });
    }
    if (intent.shape === 'top' || intent.shape === 'rank') {
      add('order_limit', 'sorted ascending instead of descending', { orderAsc: true });
    }
    if (intent.shape === 'top') {
      add('order_limit', `LIMIT ${intent.limit} missing`, { noLimit: true });
    }
    filters.forEach((filter, index) => add('filter', `filter on ${filter.value} dropped`, { dropFilter: index }));
    for (const dim of dims) {
      if (DIMS[dim].snapshot) {
        add('stale_snapshot', `grouped by the stale ${DIMS[dim].snapshot} instead of the ${dim} master data`, { snapshot: dim });
      }
      if (WRONG_JOINS[dim]) {
        add('join_path', WRONG_JOINS[dim].note, { wrongJoin: dim });
      }
    }

    // Held-out families.
    filters.forEach((filter, index) => {
      if (FILTER_SNAPSHOTS[filter.dim]) {
        addHeldout('stale_snapshot', `filter on the line snapshot ${FILTER_SNAPSHOTS[filter.dim]} instead of the ${filter.dim} master data`, { snapshotFilter: index });
      }
    });
    for (const dim of dims) {
      if (DIMS[dim].heldoutSnapshot) {
        addHeldout('stale_snapshot', `grouped by the stale ${DIMS[dim].heldoutSnapshot} instead of the ${dim} master data`, { snapshot: dim });
      }
    }
    if (isQuarterWindow(window)) {
      addHeldout('date_filter', 'QUARTER() without YEAR(): the same quarter of every year is included', { quarterOnly: true });
    }
    if (dims.length > 0 || intent.series) {
      addHeldout('cancel', 'cancel filter written as HAVING MAX(IsCanceled) = 0: drops every group with a canceled document instead of the canceled documents', { havingCancel: true });
    }
    if ((intent.shape === 'top' || intent.shape === 'rank') && ORDER_SWAPS[intent.metric]) {
      addHeldout('order_limit', ORDER_SWAPS[intent.metric].note, { orderColumn: ORDER_SWAPS[intent.metric].column });
    }
  } else if (intent.template === 'pivot') {
    add('cancel', 'canceled documents not excluded', { dropCancel: true });
    add('date_col', 'PostingDate instead of DocumentDate', { dateColumn: 'PostingDate' });
    add('date_boundary', 'first day of each window excluded', { boundary: 'start' });
    add('date_boundary', 'the day after each window included', { boundary: 'end' });
    add('metric', 'gross instead of net', { metricColumn: 'd.GrossAmount' });
    add('shape', 'the two window columns swapped', { swapColumns: true });
  } else if (intent.template === 'ledger') {
    const documentMode = intent.dateMode === 'document';
    if (intent.manualOnly) {
      skip('cancel', 'manual journals have no sales document, so there is no canceled document to exclude');
      skip('date_col', 'manual journals have no sales document, so there is no document date to read instead of PostingDate');
    } else if (documentMode) {
      add('cancel', 'postings of canceled documents not excluded', { dropCancel: true });
      add('date_col', 'AccountingPosting.PostingDate instead of SalesDocument.DocumentDate', { otherDateColumn: true });
    } else {
      skip('cancel', 'both readings (with and without postings of canceled documents) are accepted');
      add('date_col', 'SalesDocument.DocumentDate instead of AccountingPosting.PostingDate', { otherDateColumn: true });
    }
    boundaryMutants(add, intent.boundary || window.boundary);
    if (window.prior) {
      add('date_filter', 'MONTH() without YEAR()', { monthOnly: true });
    }
    if (intent.manualOnly) {
      skip('metric', 'debit and credit swapped: every manual journal is a balanced pair (double entry), so total debits equal total credits and the swap cannot change this total');
    } else if (!intent.measures.every((name) => name === 'postings')) {
      add('metric', 'debit and credit swapped', { swapDebitCredit: true });
    }
    if (intent.accountCode || intent.manualOnly) {
      const measure = intent.measures[0];
      add('metric', measure === 'credit' ? 'credits minus debits instead of the credits' : 'debits minus credits instead of the debits', { netMovement: true });
    }
    if (intent.manualOnly) {
      skip('join_type', 'an inner join to SalesDocument contradicts the manual-journal filter itself (no posting survives); dropping the filter is the control');
    } else if (!documentMode && !intent.accountCode) {
      add('join_type', 'inner join to SalesDocument drops manual journals', { innerJoinCancel: true });
    }
    if (intent.accountCode) {
      add('filter', `account ${intent.accountCode} filter dropped`, { dropFilter: true });
    }
    if (intent.manualOnly) {
      add('filter', 'manual-journal filter dropped (all postings)', { dropFilter: true });
    }
    if (intent.series) {
      add('group_by', 'the month dropped from GROUP BY: one row for the whole window under an arbitrary month label', { dropGroupKey: 'month' });
    }
    if (isQuarterWindow(window)) {
      addHeldout('date_filter', 'QUARTER() without YEAR(): the same quarter of every year is included', { quarterOnly: true });
    }
  } else {
    const designated = intent.boundary || 'start';
    const other = designated === 'start' ? 'end' : 'start';
    const knobs = {
      cancel: ['cancel', 'canceled documents not excluded', { dropCancel: true }],
      cancel_second: ['cancel', 'cancel filter applied to the first month only', { dropCancelSecond: true }],
      cancel_first: ['cancel', 'cancel filter applied to the second month only', { dropCancelFirst: true }],
      cancel_inverted: ['cancel', 'non-canceled documents counted instead of canceled ones', { invertCancel: true }],
      cancel_dropped: ['cancel', 'every document counted, canceled or not', { dropCancel: true }],
      count_docs: ['count', 'DISTINCT forgotten in the first month: COUNT(*) counts the lost customers\' February documents', { countDocs: true }],
      date_col: ['date_col', 'PostingDate instead of DocumentDate', { dateColumn: 'PostingDate' }],
      date_boundary: ['date_boundary', BOUNDARY_NOTES[designated], { boundary: designated }],
      date_boundary_other: ['date_boundary', BOUNDARY_NOTES[other], { boundary: other }],
      active: ['filter', 'IsActive filter dropped (the inactive customer is listed)', { dropActive: true }],
      min: ['metric', 'MIN instead of MAX (first purchase)', { minDate: true }],
      group_by: ['group_by', 'grouped by CustomerName only: the two customers named Summit Grocers are merged', { groupByName: true }],
      metric: ['metric', 'gross instead of net', { metricColumn: 'd.GrossAmount' }],
      grain: ['grain', 'the header amount repeated for every line', { fanOut: true }],
      order: ['order_limit', 'smallest instead of largest', { orderAsc: true }],
    };
    for (const name of intent.mutants || []) {
      if (!knobs[name]) {
        throw new Error(`${intent.intentId}: unknown mutant ${name}`);
      }
      const [type, note, m] = knobs[name];
      add(type, note, m);
    }
    const heldoutKnobs = {
      order_gross: ['order_limit', 'ranked by the gross amount while showing net', { orderColumn: 'd.GrossAmount' }],
    };
    for (const name of intent.heldoutMutants || []) {
      const [type, note, m] = heldoutKnobs[name];
      addHeldout(type, note, m);
    }
    for (const [type, reason] of Object.entries(intent.notEmitted || {})) {
      skip(type, reason);
    }
  }
  for (const [type, reason] of Object.entries(NOT_EMITTED[intent.intentId] || {})) {
    const index = mutants.findIndex((mutant) => `${mutant.type}:${mutant.note}` === type || mutant.type === type);
    if (index === -1) {
      throw new Error(`${intent.intentId}: NOT_EMITTED names ${type}, which is not one of its mutants`);
    }
    skipped.push({ type: mutants[index].type, note: mutants[index].note, reason });
    mutants.splice(index, 1);
  }
  return { mutants, heldout, skipped };
}

// --- positive controls ---------------------------------------------------------------------

function stripOrderAndLimit(sql) {
  return sql.replace(/ ORDER BY .*$/, '');
}

function outputColumns(sql) {
  const select = sql.slice(sql.indexOf('SELECT ') + 7, sql.indexOf(' FROM '));
  return select.split(/, (?![^(]*\))/).map((item) => {
    const alias = item.match(/ AS ([A-Za-z_]+)$/);
    return alias ? alias[1] : item.split('.').pop();
  });
}

function positiveFor(intent, index, gold) {
  if (!['fact', 'ledger'].includes(intent.template) || index % POSITIVE_EVERY !== 0 || /^WITH /.test(gold)) {
    return [];
  }
  const kind = ['cte', 'derived', 'alias'][Math.floor(index / POSITIVE_EVERY) % 3];
  const columns = outputColumns(gold);
  const orderMatch = gold.match(/ ORDER BY (.*?)(?: LIMIT (\d+))?$/);
  const limit = orderMatch?.[2] ? ` LIMIT ${orderMatch[2]}` : '';
  const metricAlias = columns[columns.length - 1];
  const nameColumns = columns.slice(0, -1);
  const ranked = intent.shape === 'top' || intent.shape === 'rank';
  const outerOrder = (prefix) =>
    orderMatch
      ? ` ORDER BY ${
          ranked || intent.shape === 'breakdown'
            ? [`${prefix}${metricAlias} DESC`, ...nameColumns.map((column) => `${prefix}${column} ASC`)].join(', ')
            : nameColumns.map((column) => `${prefix}${column} ASC`).join(', ')
        }${limit}`
      : '';
  if (kind === 'cte') {
    return [
      {
        id: 'p1',
        sql: `WITH totals AS (${stripOrderAndLimit(gold)}) SELECT ${columns.map((column) => `totals.${column}`).join(', ')} FROM totals${outerOrder('totals.')}`,
        note: 'the gold as a CTE, sorted and limited outside',
      },
    ];
  }
  if (kind === 'derived') {
    return [
      {
        id: 'p1',
        sql: `SELECT ${columns.map((column) => `x.${column}`).join(', ')} FROM (${stripOrderAndLimit(gold)}) AS x${outerOrder('x.')}`,
        note: 'the gold as a derived table, sorted and limited outside',
      },
    ];
  }
  const renamed = gold
    .replace(/SUM\(COALESCE\(([a-z]+\.[A-Za-z]+), 0\)\)/g, 'SUM($1)')
    .replace(new RegExp(`AS ${metricAlias}\\b`), 'AS metric_value');
  if (renamed === gold.replace(new RegExp(`AS ${metricAlias}\\b`), 'AS metric_value')) {
    return [{ id: 'p1', sql: renamed, note: 'the gold with another output alias' }];
  }
  return [{ id: 'p1', sql: renamed, note: 'the gold without COALESCE inside SUM (no NULL amounts) and with another output alias' }];
}

// --- assembly ----------------------------------------------------------------------------------

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

/**
 * Builds the dataset and its controls in memory. `previousCases` (the
 * committed dataset) supplies the expected_row_counts of cases whose id and
 * gold SQL are unchanged.
 */
export function buildEvalDataset({ previousCases = [] } = {}) {
  const previous = new Map((previousCases || []).map((testCase) => [testCase.id, testCase]));
  const cases = [];
  const controls = {};
  const problems = [];
  const seenIntents = new Set();
  const seenIds = new Set();

  INTENTS.forEach((intent, index) => {
    if (seenIntents.has(intent.intentId)) {
      problems.push(`duplicate intent ${intent.intentId}`);
    }
    seenIntents.add(intent.intentId);
    const split = TEMPLATED_SPLIT;
    const expectedSql = buildQuery(intent);
    const alternatives = alternativesFor(intent);
    const comparison = comparisonFor(intent);
    const notes = notesFor(intent);
    const tags = tagsFor(intent);
    const failureClass = failureClassFor(intent);
    const difficulty = difficultyFor(intent);
    const expectedTables = tablesOf(expectedSql);
    if (intent.phrasings.length < 2 || intent.phrasings.length > 3) {
      problems.push(`${intent.intentId}: ${intent.phrasings.length} phrasings (want 2-3)`);
    }
    const ids = [];
    for (const phrasing of intent.phrasings) {
      const question = typeof phrasing === 'string' ? phrasing : phrasing.q;
      const knownRejection = typeof phrasing === 'string' ? null : phrasing.knownRejection || null;
      const id = caseIdFor(intent.intentId, question);
      if (seenIds.has(id)) {
        problems.push(`duplicate case id ${id}`);
      }
      seenIds.add(id);
      ids.push(id);
      const prior = previous.get(id);
      const pins = prior && prior.expected_sql === expectedSql && prior.expected_row_counts ? prior.expected_row_counts : undefined;
      cases.push({
        id,
        intentId: intent.intentId,
        split,
        question,
        canonicalQuestion: typeof intent.phrasings[0] === 'string' ? intent.phrasings[0] : intent.phrasings[0].q,
        difficulty,
        tags,
        ...(failureClass ? { failure_class: failureClass } : {}),
        ...(notes ? { notes } : {}),
        expected_sql: expectedSql,
        ...(alternatives.length ? { alternative_expected_sql: alternatives } : {}),
        expected_tables: expectedTables,
        comparison,
        ...(knownRejection ? { known_validator_rejection: knownRejection } : {}),
        ...(pins ? { expected_row_counts: pins } : {}),
      });
    }

    const { mutants, heldout, skipped } = mutationsFor(intent);
    const negative = [];
    const seenSql = new Set([expectedSql, ...alternatives]);
    const emit = (mutant, prefix, extra) => {
      const sql = buildQuery(intent, mutant.m);
      if (seenSql.has(sql)) {
        problems.push(`${intent.intentId}: mutant "${mutant.note}" equals the gold or another control`);
        return;
      }
      seenSql.add(sql);
      const count = negative.filter((control) => control.id.startsWith(prefix)).length;
      negative.push({ id: `${prefix}${count + 1}`, type: mutant.type, sql, note: mutant.note, ...extra });
    };
    mutants.forEach((mutant) => emit(mutant, 'n', {}));
    heldout.forEach((mutant) => emit(mutant, 'h', { heldout: true }));
    controls[ids[0]] = {
      intentId: intent.intentId,
      gold_fingerprint: goldFingerprint(expectedSql),
      negative,
      positive: positiveFor(intent, index, expectedSql),
      ...(skipped.length ? { not_emitted: skipped } : {}),
    };
  });

  return { cases, controls, problems };
}

export function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  const previousCases = (await readJsonIfExists(DATASET_PATH)) || [];
  const { cases, controls, problems } = buildEvalDataset({ previousCases });
  if (problems.length > 0) {
    console.error(`build-eval-dataset: ${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
    return 1;
  }
  const datasetText = serialize(cases);
  const controlsText = serialize(controls);
  const intents = new Set(cases.map((testCase) => testCase.intentId));
  const formerlyHoldout = new Set(cases.filter((testCase) => testCase.tags.includes(FORMERLY_HOLDOUT_TAG)).map((testCase) => testCase.intentId));
  const negatives = Object.values(controls).reduce((sum, entry) => sum + entry.negative.length, 0);
  const positives = Object.values(controls).reduce((sum, entry) => sum + entry.positive.length, 0);
  const summary = `${cases.length} cases, ${intents.size} intents (${formerlyHoldout.size} formerly holdout, all dev), ${negatives} negative and ${positives} positive controls`;
  if (check) {
    const [currentDataset, currentControls] = await Promise.all([
      fs.readFile(DATASET_PATH, 'utf8').catch(() => ''),
      fs.readFile(CONTROLS_PATH, 'utf8').catch(() => ''),
    ]);
    const stale = [currentDataset !== datasetText ? DATASET_PATH : null, currentControls !== controlsText ? CONTROLS_PATH : null].filter(Boolean);
    if (stale.length > 0) {
      console.error(`build-eval-dataset --check: out of date: ${stale.map((file) => path.relative(ROOT, file)).join(', ')} (run npm run build-eval-dataset)`);
      return 1;
    }
    console.log(`build-eval-dataset --check: up to date (${summary}).`);
    return 0;
  }
  await fs.writeFile(DATASET_PATH, datasetText, 'utf8');
  await fs.writeFile(CONTROLS_PATH, controlsText, 'utf8');
  const unpinned = cases.filter((testCase) => !testCase.expected_row_counts).length;
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
