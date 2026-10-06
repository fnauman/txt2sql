// Synthetic demo data shared by the demo seed (scripts/seed-public-db.js) and
// every evaluation fixture (src/eval/fixtures.js).
//
// MASTER_DATA is identical in every fixture database. The model's prompt
// context (master-data candidate IDs, product names) is resolved against the
// primary fixture only, so a fixture whose dimension rows differed would test
// a different question than the one the model was shown. Fixtures may differ
// only in the fact tables (FACT_TABLES).
//
// A few master rows exist only to make wrong SQL produce wrong answers (from
// the audit's mutation workstream, .local/audit-2026-10-05/mutation/v2_fixture.sql):
// - Customer 7 "Harbor Kiosk": active but never ordered (in seed and v3; in
//   v2 it orders once while the inactive customer 6 buys too), so "active"
//   read as "has sales" counts differently.
// - Customer 8 "Summit Grocers": a second customer with the same name as
//   customer 5, so GROUP BY CustomerName (or COUNT(DISTINCT name)) merges two
//   customers.
// - Brand 5 "Clearspring Waters": a second brand whose default category is
//   Beverages, so joining Brand on Brand.ProductCategoryId fans out.
// - Product 9 "Lime Seltzer 8 Pack": a sparkling product whose name lacks
//   "sparkling water" (matched through the seltzer tag, the semantic layer's
//   sparkling-water alias).
// - Product 10 "Spring Water 24 Pack": still water, a decoy for LIKE '%water%'.
// - Product 11 "Sparkling Water 24 Pack": a second sparkling SKU.
// - Product 12 "Northstar Trail Crisps": a Northstar-brand product in Snacks,
//   while the Northstar brand's default category is Beverages.
// - Product 13 "Oat Cookies Tin": discontinued (IsActive = 0) but sold in
//   March 2026 in v2 and v3, so an invented "active products only" filter
//   changes product, brand, category and campaign totals. (Customer 6, the
//   inactive customer, likewise buys in January-March 2026 there.)
// The semantic layer needs no change for them: "seltzer" is already an alias
// of "sparkling water", and "trail mix" / "sparkling water" do not match the
// decoys (product resolution needs every term token).

export const TABLE_COLUMNS = Object.freeze({
  Campaign: ['CampaignId', 'CampaignCode', 'CampaignName'],
  ProductCategory: ['ProductCategoryId', 'CategoryCode', 'CategoryName', 'ParentCategoryId'],
  Brand: ['BrandId', 'BrandCode', 'BrandName', 'ProductCategoryId'],
  Customer: ['CustomerId', 'CustomerCode', 'CustomerName', 'CustomerSegment', 'IsActive'],
  StoreLocation: ['StoreLocationId', 'LocationCode', 'LocationName'],
  DocumentType: ['DocumentTypeId', 'DocumentTypeName', 'DocumentTypeClass'],
  LedgerAccount: ['LedgerAccountId', 'AccountCode', 'AccountName'],
  Product: ['ProductId', 'ProductCode', 'ProductName', 'ProductTags', 'ProductCategoryId', 'BrandId', 'CampaignId', 'IsActive'],
  ProductBrand: ['ProductBrandId', 'ProductId', 'BrandId'],
  CustomerProductPrice: ['CustomerProductPriceId', 'CustomerId', 'ProductId', 'SalePrice', 'EffectiveDate'],
  SalesDocument: [
    'SalesDocumentId',
    'DocumentNo',
    'DocumentDate',
    'PostingDate',
    'DueDate',
    'CustomerId',
    'StoreLocationId',
    'DocumentTypeId',
    'CampaignId',
    'IsCanceled',
    'GrossAmount',
    'NetAmount',
    'NetPayableAmount',
    'PaidAmount',
    'BalanceAmount',
    'SubtotalAmount',
    'BillTotalAmount',
  ],
  SalesDocumentLine: [
    'SalesDocumentLineId',
    'SalesDocumentId',
    'ProductId',
    'ProductNameSnapshot',
    'Quantity',
    'SalePrice',
    'TotalAmount',
    'NetAmount',
    'CategoryNameSnapshot',
    'BrandNameSnapshot',
  ],
  AccountingPosting: ['AccountingPostingId', 'SalesDocumentId', 'LedgerAccountId', 'PostingDate', 'DebitAmount', 'CreditAmount'],
});

// Insert order (parents first); deletes run in reverse.
export const MASTER_TABLES = Object.freeze([
  'Campaign',
  'ProductCategory',
  'Brand',
  'Customer',
  'StoreLocation',
  'DocumentType',
  'LedgerAccount',
  'Product',
  'ProductBrand',
  'CustomerProductPrice',
]);
export const FACT_TABLES = Object.freeze(['SalesDocument', 'SalesDocumentLine', 'AccountingPosting']);
export const SEEDED_TABLES = Object.freeze([...MASTER_TABLES, ...FACT_TABLES]);

export const PRIMARY_KEYS = Object.freeze(Object.fromEntries(Object.entries(TABLE_COLUMNS).map(([table, columns]) => [table, columns[0]])));

const freezeRows = (rows) => Object.freeze(rows.map((row) => Object.freeze({ ...row })));

export const MASTER_DATA = Object.freeze({
  Campaign: freezeRows([
    { CampaignId: 1, CampaignCode: 'CMP-SPRING', CampaignName: 'Spring Essentials' },
    { CampaignId: 2, CampaignCode: 'CMP-URBAN', CampaignName: 'Urban Refresh' },
    { CampaignId: 3, CampaignCode: 'CMP-WEEKEND', CampaignName: 'Weekend Pantry' },
  ]),
  ProductCategory: freezeRows([
    { ProductCategoryId: 1, CategoryCode: 'BEV', CategoryName: 'Beverages', ParentCategoryId: null },
    { ProductCategoryId: 2, CategoryCode: 'SNK', CategoryName: 'Snacks', ParentCategoryId: null },
    { ProductCategoryId: 3, CategoryCode: 'PAN', CategoryName: 'Pantry', ParentCategoryId: null },
    { ProductCategoryId: 4, CategoryCode: 'HH', CategoryName: 'Household', ParentCategoryId: null },
  ]),
  Brand: freezeRows([
    { BrandId: 1, BrandCode: 'NORTH', BrandName: 'Northstar Goods', ProductCategoryId: 1 },
    { BrandId: 2, BrandCode: 'SUN', BrandName: 'Sunvale Foods', ProductCategoryId: 2 },
    { BrandId: 3, BrandCode: 'RIVER', BrandName: 'Riverbend Pantry', ProductCategoryId: 3 },
    { BrandId: 4, BrandCode: 'HOME', BrandName: 'Homebase Supply', ProductCategoryId: 4 },
    { BrandId: 5, BrandCode: 'CLEAR', BrandName: 'Clearspring Waters', ProductCategoryId: 1 },
  ]),
  Customer: freezeRows([
    { CustomerId: 1, CustomerCode: 'C-001', CustomerName: 'North District Market', CustomerSegment: 'Retail', IsActive: 1 },
    { CustomerId: 2, CustomerCode: 'C-002', CustomerName: 'Lakeside Wholesale', CustomerSegment: 'Wholesale', IsActive: 1 },
    { CustomerId: 3, CustomerCode: 'C-003', CustomerName: 'Metro Online Store', CustomerSegment: 'Online', IsActive: 1 },
    { CustomerId: 4, CustomerCode: 'C-004', CustomerName: 'Valley Corner Shop', CustomerSegment: 'Retail', IsActive: 1 },
    { CustomerId: 5, CustomerCode: 'C-005', CustomerName: 'Summit Grocers', CustomerSegment: 'Wholesale', IsActive: 1 },
    { CustomerId: 6, CustomerCode: 'C-006', CustomerName: 'Dormant Demo Account', CustomerSegment: 'Retail', IsActive: 0 },
    { CustomerId: 7, CustomerCode: 'C-007', CustomerName: 'Harbor Kiosk', CustomerSegment: 'Retail', IsActive: 1 },
    { CustomerId: 8, CustomerCode: 'C-008', CustomerName: 'Summit Grocers', CustomerSegment: 'Wholesale', IsActive: 1 },
  ]),
  StoreLocation: freezeRows([
    { StoreLocationId: 1, LocationCode: 'NORTH', LocationName: 'North Warehouse' },
    { StoreLocationId: 2, LocationCode: 'SOUTH', LocationName: 'South Store' },
    { StoreLocationId: 3, LocationCode: 'ONLINE', LocationName: 'Online Fulfillment' },
  ]),
  DocumentType: freezeRows([
    { DocumentTypeId: 1, DocumentTypeName: 'Sales Invoice', DocumentTypeClass: 'Invoice' },
    { DocumentTypeId: 2, DocumentTypeName: 'Online Order', DocumentTypeClass: 'Order' },
    { DocumentTypeId: 3, DocumentTypeName: 'Credit Memo', DocumentTypeClass: 'Adjustment' },
    { DocumentTypeId: 4, DocumentTypeName: 'Store Receipt', DocumentTypeClass: 'Receipt' },
  ]),
  LedgerAccount: freezeRows([
    { LedgerAccountId: 1, AccountCode: '4000', AccountName: 'Sales Revenue' },
    { LedgerAccountId: 2, AccountCode: '1100', AccountName: 'Accounts Receivable' },
    { LedgerAccountId: 3, AccountCode: '5000', AccountName: 'Cost Of Goods Sold' },
    { LedgerAccountId: 4, AccountCode: '2100', AccountName: 'Sales Tax Payable' },
  ]),
  Product: freezeRows([
    { ProductId: 1, ProductCode: 'BEV-SPARK-12', ProductName: 'Sparkling Water 12 Pack', ProductTags: 'seltzer carbonated fizzy water', ProductCategoryId: 1, BrandId: 1, CampaignId: 2, IsActive: 1 },
    { ProductId: 2, ProductCode: 'SNK-PRO-BOX', ProductName: 'Protein Bar Box', ProductTags: 'energy bar meal bar', ProductCategoryId: 2, BrandId: 2, CampaignId: 1, IsActive: 1 },
    { ProductId: 3, ProductCode: 'BEV-COLD-6', ProductName: 'Cold Brew Coffee 6 Pack', ProductTags: 'iced coffee ready to drink coffee', ProductCategoryId: 1, BrandId: 1, CampaignId: 2, IsActive: 1 },
    { ProductId: 4, ProductCode: 'SNK-TRAIL-1', ProductName: 'Trail Mix Pouch', ProductTags: 'nuts dried fruit snack', ProductCategoryId: 2, BrandId: 2, CampaignId: 3, IsActive: 1 },
    { ProductId: 5, ProductCode: 'PAN-RICE-5', ProductName: 'Long Grain Rice 5kg', ProductTags: 'pantry rice staple', ProductCategoryId: 3, BrandId: 3, CampaignId: 3, IsActive: 1 },
    { ProductId: 6, ProductCode: 'HH-TOWEL-4', ProductName: 'Kitchen Towels 4 Roll', ProductTags: 'household paper towels', ProductCategoryId: 4, BrandId: 4, CampaignId: 1, IsActive: 1 },
    { ProductId: 7, ProductCode: 'PAN-SUGAR-2', ProductName: 'Cane Sugar 2kg', ProductTags: 'pantry sugar baking', ProductCategoryId: 3, BrandId: 3, CampaignId: 3, IsActive: 1 },
    { ProductId: 8, ProductCode: 'BEV-TEA-20', ProductName: 'Herbal Tea Variety Pack', ProductTags: 'tea beverage', ProductCategoryId: 1, BrandId: 1, CampaignId: 1, IsActive: 1 },
    { ProductId: 9, ProductCode: 'BEV-LIME-8', ProductName: 'Lime Seltzer 8 Pack', ProductTags: 'seltzer flavored lime', ProductCategoryId: 1, BrandId: 1, CampaignId: 2, IsActive: 1 },
    { ProductId: 10, ProductCode: 'BEV-SPRING-24', ProductName: 'Spring Water 24 Pack', ProductTags: 'still bottled water', ProductCategoryId: 1, BrandId: 5, CampaignId: 1, IsActive: 1 },
    { ProductId: 11, ProductCode: 'BEV-SPARK-24', ProductName: 'Sparkling Water 24 Pack', ProductTags: 'seltzer carbonated water bulk', ProductCategoryId: 1, BrandId: 1, CampaignId: 2, IsActive: 1 },
    { ProductId: 12, ProductCode: 'SNK-NCRISP-1', ProductName: 'Northstar Trail Crisps', ProductTags: 'crisps snack', ProductCategoryId: 2, BrandId: 1, CampaignId: 3, IsActive: 1 },
    { ProductId: 13, ProductCode: 'SNK-OATCK-1', ProductName: 'Oat Cookies Tin', ProductTags: 'cookies biscuits snack discontinued', ProductCategoryId: 2, BrandId: 2, CampaignId: 2, IsActive: 0 },
  ]),
  ProductBrand: freezeRows([
    { ProductBrandId: 1, ProductId: 1, BrandId: 1 },
    { ProductBrandId: 2, ProductId: 2, BrandId: 2 },
    { ProductBrandId: 3, ProductId: 3, BrandId: 1 },
    { ProductBrandId: 4, ProductId: 4, BrandId: 2 },
  ]),
  CustomerProductPrice: freezeRows([
    { CustomerProductPriceId: 1, CustomerId: 1, ProductId: 1, SalePrice: 58, EffectiveDate: '2026-01-01' },
    { CustomerProductPriceId: 2, CustomerId: 2, ProductId: 3, SalePrice: 38, EffectiveDate: '2026-01-01' },
    { CustomerProductPriceId: 3, CustomerId: 4, ProductId: 2, SalePrice: 78, EffectiveDate: '2026-02-01' },
  ]),
});

// The original demo seed's facts (fixture "seed", database demo_retail):
// 9 documents, 10 lines, 10 postings, January-April 2026.
export const SEED_FACTS = Object.freeze({
  SalesDocument: freezeRows([
    { SalesDocumentId: 1, DocumentNo: 'SD-2026-0001', DocumentDate: '2026-03-05', PostingDate: '2026-03-06', DueDate: '2026-04-05', CustomerId: 1, StoreLocationId: 1, DocumentTypeId: 1, CampaignId: 2, IsCanceled: 0, GrossAmount: 1120, NetAmount: 1000, NetPayableAmount: 1000, PaidAmount: 750, BalanceAmount: 250, SubtotalAmount: 1050, BillTotalAmount: 1120 },
    { SalesDocumentId: 2, DocumentNo: 'SD-2026-0002', DocumentDate: '2026-03-10', PostingDate: '2026-03-10', DueDate: '2026-04-10', CustomerId: 2, StoreLocationId: 1, DocumentTypeId: 1, CampaignId: 2, IsCanceled: 0, GrossAmount: 880, NetAmount: 800, NetPayableAmount: 800, PaidAmount: 800, BalanceAmount: 0, SubtotalAmount: 830, BillTotalAmount: 880 },
    { SalesDocumentId: 3, DocumentNo: 'SD-2026-0003', DocumentDate: '2026-03-12', PostingDate: '2026-03-13', DueDate: '2026-04-12', CustomerId: 3, StoreLocationId: 3, DocumentTypeId: 2, CampaignId: 3, IsCanceled: 0, GrossAmount: 530, NetAmount: 500, NetPayableAmount: 500, PaidAmount: 300, BalanceAmount: 200, SubtotalAmount: 515, BillTotalAmount: 530 },
    { SalesDocumentId: 4, DocumentNo: 'SD-2026-0004', DocumentDate: '2026-02-20', PostingDate: '2026-02-21', DueDate: '2026-03-20', CustomerId: 1, StoreLocationId: 2, DocumentTypeId: 1, CampaignId: 3, IsCanceled: 0, GrossAmount: 760, NetAmount: 700, NetPayableAmount: 700, PaidAmount: 700, BalanceAmount: 0, SubtotalAmount: 730, BillTotalAmount: 760 },
    { SalesDocumentId: 5, DocumentNo: 'SD-2026-0005', DocumentDate: '2026-02-25', PostingDate: '2026-02-25', DueDate: '2026-03-25', CustomerId: 4, StoreLocationId: 2, DocumentTypeId: 4, CampaignId: 1, IsCanceled: 0, GrossAmount: 330, NetAmount: 300, NetPayableAmount: 300, PaidAmount: 300, BalanceAmount: 0, SubtotalAmount: 315, BillTotalAmount: 330 },
    { SalesDocumentId: 6, DocumentNo: 'SD-2026-0006', DocumentDate: '2026-03-15', PostingDate: '2026-03-15', DueDate: '2026-04-15', CustomerId: 4, StoreLocationId: 2, DocumentTypeId: 3, CampaignId: 1, IsCanceled: 1, GrossAmount: 220, NetAmount: 200, NetPayableAmount: 200, PaidAmount: 0, BalanceAmount: 200, SubtotalAmount: 210, BillTotalAmount: 220 },
    { SalesDocumentId: 7, DocumentNo: 'SD-2026-0007', DocumentDate: '2026-01-10', PostingDate: '2026-01-11', DueDate: '2026-02-10', CustomerId: 5, StoreLocationId: 1, DocumentTypeId: 1, CampaignId: 1, IsCanceled: 0, GrossAmount: 490, NetAmount: 450, NetPayableAmount: 450, PaidAmount: 450, BalanceAmount: 0, SubtotalAmount: 460, BillTotalAmount: 490 },
    { SalesDocumentId: 8, DocumentNo: 'SD-2026-0008', DocumentDate: '2026-03-18', PostingDate: '2026-03-19', DueDate: '2026-04-18', CustomerId: 5, StoreLocationId: 3, DocumentTypeId: 4, CampaignId: 3, IsCanceled: 0, GrossAmount: 700, NetAmount: 650, NetPayableAmount: 650, PaidAmount: 650, BalanceAmount: 0, SubtotalAmount: 675, BillTotalAmount: 700 },
    { SalesDocumentId: 9, DocumentNo: 'SD-2026-0009', DocumentDate: '2026-04-05', PostingDate: '2026-04-05', DueDate: '2026-05-05', CustomerId: 2, StoreLocationId: 1, DocumentTypeId: 1, CampaignId: 2, IsCanceled: 0, GrossAmount: 980, NetAmount: 900, NetPayableAmount: 900, PaidAmount: 0, BalanceAmount: 900, SubtotalAmount: 940, BillTotalAmount: 980 },
  ]),
  SalesDocumentLine: freezeRows([
    { SalesDocumentLineId: 1, SalesDocumentId: 1, ProductId: 1, ProductNameSnapshot: 'Sparkling Water 12 Pack', Quantity: 10, SalePrice: 60, TotalAmount: 600, NetAmount: 600, CategoryNameSnapshot: 'Beverages', BrandNameSnapshot: 'Northstar Goods' },
    { SalesDocumentLineId: 2, SalesDocumentId: 1, ProductId: 2, ProductNameSnapshot: 'Protein Bar Box', Quantity: 5, SalePrice: 80, TotalAmount: 400, NetAmount: 400, CategoryNameSnapshot: 'Snacks', BrandNameSnapshot: 'Sunvale Foods' },
    { SalesDocumentLineId: 3, SalesDocumentId: 2, ProductId: 3, ProductNameSnapshot: 'Cold Brew Coffee 6 Pack', Quantity: 20, SalePrice: 40, TotalAmount: 800, NetAmount: 800, CategoryNameSnapshot: 'Beverages', BrandNameSnapshot: 'Northstar Goods' },
    { SalesDocumentLineId: 4, SalesDocumentId: 3, ProductId: 4, ProductNameSnapshot: 'Trail Mix Pouch', Quantity: 12, SalePrice: 41.67, TotalAmount: 500, NetAmount: 500, CategoryNameSnapshot: 'Snacks', BrandNameSnapshot: 'Sunvale Foods' },
    { SalesDocumentLineId: 5, SalesDocumentId: 4, ProductId: 5, ProductNameSnapshot: 'Long Grain Rice 5kg', Quantity: 7, SalePrice: 100, TotalAmount: 700, NetAmount: 700, CategoryNameSnapshot: 'Pantry', BrandNameSnapshot: 'Riverbend Pantry' },
    { SalesDocumentLineId: 6, SalesDocumentId: 5, ProductId: 2, ProductNameSnapshot: 'Protein Bar Box', Quantity: 3, SalePrice: 100, TotalAmount: 300, NetAmount: 300, CategoryNameSnapshot: 'Snacks', BrandNameSnapshot: 'Sunvale Foods' },
    { SalesDocumentLineId: 7, SalesDocumentId: 6, ProductId: 6, ProductNameSnapshot: 'Kitchen Towels 4 Roll', Quantity: 4, SalePrice: 50, TotalAmount: 200, NetAmount: 200, CategoryNameSnapshot: 'Household', BrandNameSnapshot: 'Homebase Supply' },
    { SalesDocumentLineId: 8, SalesDocumentId: 7, ProductId: 6, ProductNameSnapshot: 'Kitchen Towels 4 Roll', Quantity: 9, SalePrice: 50, TotalAmount: 450, NetAmount: 450, CategoryNameSnapshot: 'Household', BrandNameSnapshot: 'Homebase Supply' },
    { SalesDocumentLineId: 9, SalesDocumentId: 8, ProductId: 7, ProductNameSnapshot: 'Cane Sugar 2kg', Quantity: 13, SalePrice: 50, TotalAmount: 650, NetAmount: 650, CategoryNameSnapshot: 'Pantry', BrandNameSnapshot: 'Riverbend Pantry' },
    { SalesDocumentLineId: 10, SalesDocumentId: 9, ProductId: 1, ProductNameSnapshot: 'Sparkling Water 12 Pack', Quantity: 15, SalePrice: 60, TotalAmount: 900, NetAmount: 900, CategoryNameSnapshot: 'Beverages', BrandNameSnapshot: 'Northstar Goods' },
  ]),
  AccountingPosting: freezeRows([
    { AccountingPostingId: 1, SalesDocumentId: 1, LedgerAccountId: 2, PostingDate: '2026-03-06', DebitAmount: 1000, CreditAmount: 0 },
    { AccountingPostingId: 2, SalesDocumentId: 1, LedgerAccountId: 1, PostingDate: '2026-03-06', DebitAmount: 0, CreditAmount: 1000 },
    { AccountingPostingId: 3, SalesDocumentId: 2, LedgerAccountId: 2, PostingDate: '2026-03-10', DebitAmount: 800, CreditAmount: 0 },
    { AccountingPostingId: 4, SalesDocumentId: 2, LedgerAccountId: 1, PostingDate: '2026-03-10', DebitAmount: 0, CreditAmount: 800 },
    { AccountingPostingId: 5, SalesDocumentId: 4, LedgerAccountId: 2, PostingDate: '2026-02-21', DebitAmount: 700, CreditAmount: 0 },
    { AccountingPostingId: 6, SalesDocumentId: 4, LedgerAccountId: 1, PostingDate: '2026-02-21', DebitAmount: 0, CreditAmount: 700 },
    { AccountingPostingId: 7, SalesDocumentId: 8, LedgerAccountId: 2, PostingDate: '2026-03-19', DebitAmount: 650, CreditAmount: 0 },
    { AccountingPostingId: 8, SalesDocumentId: 8, LedgerAccountId: 1, PostingDate: '2026-03-19', DebitAmount: 0, CreditAmount: 650 },
    { AccountingPostingId: 9, SalesDocumentId: 9, LedgerAccountId: 2, PostingDate: '2026-04-05', DebitAmount: 900, CreditAmount: 0 },
    { AccountingPostingId: 10, SalesDocumentId: 9, LedgerAccountId: 1, PostingDate: '2026-04-05', DebitAmount: 0, CreditAmount: 900 },
  ]),
});
