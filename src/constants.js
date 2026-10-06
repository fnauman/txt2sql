export const DEFAULT_INCLUDED_TABLES = [
  'SalesDocument',
  'SalesDocumentLine',
  'Product',
  'Customer',
  'StoreLocation',
  'DocumentType',
  'AccountingPosting',
  'LedgerAccount',
  'CustomerProductPrice',
  'Campaign',
  'ProductCategory',
  'Brand',
  'ProductBrand',
];

export const TABLE_ALIASES = {
  SalesDocument: ['document', 'documents', 'sales document', 'sales documents', 'invoice', 'invoices', 'order', 'orders', 'sale', 'sales', 'transaction', 'transactions'],
  SalesDocumentLine: ['line', 'lines', 'detail', 'details', 'line item', 'line items', 'quantity', 'qty', 'sold', 'product sales'],
  Product: ['product', 'products', 'item', 'items', 'sku', 'skus', 'merchandise', 'goods'],
  Customer: ['customer', 'customers', 'client', 'clients', 'account', 'accounts', 'buyer', 'buyers'],
  StoreLocation: ['location', 'locations', 'branch', 'branches', 'warehouse', 'warehouses', 'store', 'stores'],
  DocumentType: ['document type', 'document types', 'document class', 'document classes', 'invoice', 'invoices', 'credit memo', 'receipt'],
  AccountingPosting: ['posting', 'postings', 'ledger', 'accounting', 'debit', 'credit', 'journal'],
  LedgerAccount: ['account', 'accounts', 'ledger account', 'ledger accounts', 'general ledger', 'gl account'],
  CustomerProductPrice: ['price', 'prices', 'pricing', 'customer price', 'special price'],
  Campaign: ['campaign', 'campaigns', 'program', 'programs', 'promotion', 'promotions'],
  ProductCategory: ['product category', 'product categories', 'category', 'categories', 'department', 'departments'],
  Brand: ['brand', 'brands', 'manufacturer brand', 'label', 'labels'],
  ProductBrand: ['product brand', 'product brands', 'brand assignment', 'brand bridge'],
};

// The read-only validator rejects any SQL comment (SQL_COMMENT, EXECUTABLE_COMMENT),
// so both the basic and the optimized prompt tell the model not to write one.
export const NO_SQL_COMMENTS_RULE =
  'Do not write SQL comments (--, #, /* */) anywhere in the query: SQL that contains a comment is rejected.';

export const BUSINESS_RULES = [
  'Write MariaDB 10.6 compatible SQL only.',
  NO_SQL_COMMENTS_RULE,
  'Use only the tables and foreign keys provided in the prompt context. Ignore all missing or implied relationships.',
  'If the prompt resolves temporal references, use those exact normalized interpretations and do not reinterpret ambiguous dates or years.',
  'For month or date filters, prefer half-open ranges like date_col >= start_date AND date_col < end_exclusive instead of MONTH() or YEAR() wrappers.',
  'For sales date questions, prefer SalesDocument.DocumentDate unless the user explicitly asks for posting date or due date.',
  'Use SalesDocument.PostingDate or AccountingPosting.PostingDate for posted-date questions and SalesDocument.DueDate for aging or due-date questions.',
  'Unless the user explicitly asks for canceled documents, exclude them with IFNULL(SalesDocument.IsCanceled, 0) = 0 when querying SalesDocument.',
  'For outstanding or unpaid sales document amounts, use SalesDocument.BalanceAmount. For paid amounts, use SalesDocument.PaidAmount.',
  'For document-level totals, prefer the explicitly named header amounts such as SalesDocument.NetAmount, SalesDocument.NetPayableAmount, SalesDocument.BillTotalAmount, or SalesDocument.SubtotalAmount based on the wording of the question.',
  'If the user names a document type or document class, join DocumentType and filter by DocumentType.DocumentTypeName instead of guessing numeric type IDs.',
  'For product-level analysis, prefer SalesDocumentLine.Quantity, SalesDocumentLine.SalePrice, SalesDocumentLine.TotalAmount, and SalesDocumentLine.NetAmount.',
  'For accounting questions, use AccountingPosting with LedgerAccount and aggregate DebitAmount/CreditAmount columns instead of sales document header totals.',
  'For user-provided entity names (customer, store location, campaign, product category, brand, product), prefer LIKE with surrounding wildcards on canonical name columns instead of exact equality, unless the user explicitly asks for an exact match.',
  'For named customer or store-location filters, include Customer.CustomerName and StoreLocation.LocationName as candidate text filters when those tables are in scope.',
  'For campaign-filtered product sales, join SalesDocumentLine to Product and Product to Campaign, then filter Campaign.CampaignName with LIKE. Do not require an external campaign ID variable when Campaign is in scope.',
  'For product categories, prefer ProductCategory joined through Product.ProductCategoryId instead of stale SalesDocumentLine.CategoryNameSnapshot values when ProductCategory is in scope.',
  'For brand analysis, prefer Brand joined through Product.BrandId or ProductBrand instead of stale SalesDocumentLine.BrandNameSnapshot values when Brand is in scope.',
  'If the business meaning is ambiguous, choose the most directly named column and state that assumption in the JSON response.',
  'Unless requested otherwise, project only the most specific display name columns for entities: select only CustomerName for customer, only ProductName for product, only LocationName for store location, and only DocumentTypeName for document type. Do not project ID or code columns unless explicitly requested or needed for query logic.',
  'Select LedgerAccount.AccountCode and LedgerAccount.AccountName when ledger accounts are requested.',
  'For currency/amount metrics (net sales, debit, credit), round the aggregated sum to 2 decimal places using ROUND(..., 2). Alias the aggregated sum of net sales/revenue as total_net_amount, debit as total_debit, and credit as total_credit.',
  'For quantity metrics (qty sold, moved), round the aggregated sum to 3 decimal places using ROUND(..., 3). Alias the aggregated sum of quantity as total_qty.',
  'For counts, alias sales document/document counts as document_count, and product/SKU counts as product_count.',
  'For "not in" or "did not sell in" temporal comparison questions (anti-joins), write the query using a LEFT JOIN ... WHERE ... IS NULL or NOT EXISTS pattern. Avoid restricting the main WHERE clause to the first period if you also filter the second period there, as that removes the comparison data before the anti-join or HAVING clause can process it.',
  'For "top", "biggest", or "most" ranking queries, always apply a LIMIT 10 unless a different limit is explicitly specified.',
  'When sorting ranking queries, sort rounded aggregate outputs by the underlying unrounded aggregate expression first, then use a secondary deterministic sort key (e.g., entity name/code like CustomerName, ProductName, AccountCode) in ASC order to handle equal values cleanly.',
];

// Hints version 2 (src/hints-version.js, docs/experiments/02-hints-v2.md):
// version 1's rules with the ambiguous ones rewritten. Each replacement names
// the version-1 rule it replaces.
const V1_TEMPORAL_RULE = BUSINESS_RULES[3];

const HINTS_V2_RULE_REPLACEMENTS = new Map([
  // Version 1 told the model not to reinterpret dates even when the resolver
  // had turned "between 1 and 10 March 2026" into all of March. Version 2
  // resolves only whole-month phrases it fully understands, and says so.
  [
    V1_TEMPORAL_RULE,
    'Resolved temporal references are exact for the phrases they quote: use their half-open ranges for those phrases. Date wording that is not listed there (quarters, day or month ranges, as-of or relative dates) was not resolved: work out the window from the question itself, again as a half-open range.',
  ],
]);

for (const replaced of HINTS_V2_RULE_REPLACEMENTS.keys()) {
  if (!BUSINESS_RULES.includes(replaced)) {
    throw new Error(`Hints v2 replaces a business rule that is not in BUSINESS_RULES: ${replaced}`);
  }
}

export const BUSINESS_RULES_V2 = Object.freeze(BUSINESS_RULES.map((rule) => HINTS_V2_RULE_REPLACEMENTS.get(rule) ?? rule));

/**
 * The business rules of hints version `version` (src/hints-version.js).
 * Version 1 is BUSINESS_RULES, unchanged.
 */
export function businessRulesFor(version = 1) {
  return Number(version) === 1 ? BUSINESS_RULES : BUSINESS_RULES_V2;
}

// Few-shot examples teach patterns (anti-joins, header grain with a dimension,
// HAVING) with intents that appear in NO benchmark dataset: an example equal
// or near-equal to a gold query would make the benchmark measure recall of the
// prompt (test/few-shot-leakage.test.js enforces it).
export const FEW_SHOT_EXAMPLES = [
  {
    question: 'Which products have never been sold?',
    tables: ['Product', 'SalesDocumentLine', 'SalesDocument'],
    sql: `SELECT p.ProductName
FROM Product p
WHERE NOT EXISTS (
  SELECT 1
  FROM SalesDocumentLine l
  JOIN SalesDocument d ON l.SalesDocumentId = d.SalesDocumentId
  WHERE l.ProductId = p.ProductId
    AND IFNULL(d.IsCanceled, 0) = 0
)
ORDER BY p.ProductName ASC`,
  },
  {
    question: 'Show net sales by store location',
    tables: ['SalesDocument', 'StoreLocation'],
    sql: `SELECT s.LocationName, ROUND(SUM(COALESCE(d.NetAmount, 0)), 2) AS total_net_amount
FROM SalesDocument d
JOIN StoreLocation s ON d.StoreLocationId = s.StoreLocationId
WHERE IFNULL(d.IsCanceled, 0) = 0
GROUP BY s.StoreLocationId, s.LocationName
ORDER BY SUM(COALESCE(d.NetAmount, 0)) DESC, s.LocationName ASC`,
  },
  {
    question: 'Show outstanding balance by customer',
    tables: ['SalesDocument', 'Customer'],
    sql: `SELECT c.CustomerName, ROUND(SUM(COALESCE(d.BalanceAmount, 0)), 2) AS outstanding_balance
FROM SalesDocument d
JOIN Customer c ON d.CustomerId = c.CustomerId
WHERE IFNULL(d.IsCanceled, 0) = 0
  AND COALESCE(d.BalanceAmount, 0) > 0
GROUP BY c.CustomerId, c.CustomerName
ORDER BY SUM(COALESCE(d.BalanceAmount, 0)) DESC, c.CustomerName ASC`,
  },
  {
    question: 'Which customers had more than 2 sales documents in 2026?',
    tables: ['SalesDocument', 'Customer'],
    sql: `SELECT c.CustomerName, COUNT(*) AS document_count
FROM SalesDocument d
JOIN Customer c ON d.CustomerId = c.CustomerId
WHERE IFNULL(d.IsCanceled, 0) = 0
  AND d.DocumentDate >= '2026-01-01'
  AND d.DocumentDate < '2027-01-01'
GROUP BY c.CustomerId, c.CustomerName
HAVING COUNT(*) > 2
ORDER BY COUNT(*) DESC, c.CustomerName ASC`,
  },
];

export const DEFAULT_BASIC_QUESTIONS = [
  'How many active customers do we have?',
  'Show outstanding balance by customer',
  'What are the top 10 products by quantity sold?',
];

export const DEFAULT_OPTIMIZED_QUESTIONS = [
  'What are the top 10 products by quantity sold?',
  'Show debit and credit totals by ledger account',
  'How many sales documents do we have by document type?',
  'Show outstanding balance by customer',
];

// Where a failed question stopped. Returned on every failed result (and by the
// web API) so callers can tell "blocked by guardrails" from "MariaDB error" or
// "LLM unavailable" without parsing message text.
export const ERROR_STAGES = Object.freeze(['llm', 'validation', 'execution', 'aborted', 'infra']);
