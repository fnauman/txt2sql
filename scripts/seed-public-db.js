import { loadEnvironment } from '../src/env.js';
import { createMariaDbConnection } from '../src/pipeline.js';

const TABLES = [
  'AccountingPosting',
  'CustomerProductPrice',
  'ProductBrand',
  'SalesDocumentLine',
  'SalesDocument',
  'Product',
  'Brand',
  'ProductCategory',
  'Customer',
  'StoreLocation',
  'DocumentType',
  'LedgerAccount',
  'Campaign',
];

function quoteIdentifier(value) {
  return '`' + String(value).replace(/`/g, '``') + '`';
}

async function insertRows(connection, table, columns, rows) {
  if (rows.length === 0) {
    return;
  }
  const columnSql = columns.map(quoteIdentifier).join(', ');
  const placeholders = rows.map(() => '(' + columns.map(() => '?').join(', ') + ')').join(', ');
  const params = rows.flatMap((row) => columns.map((column) => row[column] ?? null));
  await connection.query('INSERT INTO ' + quoteIdentifier(table) + ' (' + columnSql + ') VALUES ' + placeholders, params);
}

async function seedDemoDatabase(connection) {
  await connection.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const table of TABLES) {
      await connection.query('DELETE FROM ' + quoteIdentifier(table));
    }
  } finally {
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  await insertRows(connection, 'Campaign', ['CampaignId', 'CampaignCode', 'CampaignName'], [
    { CampaignId: 1, CampaignCode: 'CMP-SPRING', CampaignName: 'Spring Essentials' },
    { CampaignId: 2, CampaignCode: 'CMP-URBAN', CampaignName: 'Urban Refresh' },
    { CampaignId: 3, CampaignCode: 'CMP-WEEKEND', CampaignName: 'Weekend Pantry' },
  ]);

  await insertRows(connection, 'ProductCategory', ['ProductCategoryId', 'CategoryCode', 'CategoryName', 'ParentCategoryId'], [
    { ProductCategoryId: 1, CategoryCode: 'BEV', CategoryName: 'Beverages', ParentCategoryId: null },
    { ProductCategoryId: 2, CategoryCode: 'SNK', CategoryName: 'Snacks', ParentCategoryId: null },
    { ProductCategoryId: 3, CategoryCode: 'PAN', CategoryName: 'Pantry', ParentCategoryId: null },
    { ProductCategoryId: 4, CategoryCode: 'HH', CategoryName: 'Household', ParentCategoryId: null },
  ]);

  await insertRows(connection, 'Brand', ['BrandId', 'BrandCode', 'BrandName', 'ProductCategoryId'], [
    { BrandId: 1, BrandCode: 'NORTH', BrandName: 'Northstar Goods', ProductCategoryId: 1 },
    { BrandId: 2, BrandCode: 'SUN', BrandName: 'Sunvale Foods', ProductCategoryId: 2 },
    { BrandId: 3, BrandCode: 'RIVER', BrandName: 'Riverbend Pantry', ProductCategoryId: 3 },
    { BrandId: 4, BrandCode: 'HOME', BrandName: 'Homebase Supply', ProductCategoryId: 4 },
  ]);

  await insertRows(connection, 'Customer', ['CustomerId', 'CustomerCode', 'CustomerName', 'CustomerSegment', 'IsActive'], [
    { CustomerId: 1, CustomerCode: 'C-001', CustomerName: 'North District Market', CustomerSegment: 'Retail', IsActive: 1 },
    { CustomerId: 2, CustomerCode: 'C-002', CustomerName: 'Lakeside Wholesale', CustomerSegment: 'Wholesale', IsActive: 1 },
    { CustomerId: 3, CustomerCode: 'C-003', CustomerName: 'Metro Online Store', CustomerSegment: 'Online', IsActive: 1 },
    { CustomerId: 4, CustomerCode: 'C-004', CustomerName: 'Valley Corner Shop', CustomerSegment: 'Retail', IsActive: 1 },
    { CustomerId: 5, CustomerCode: 'C-005', CustomerName: 'Summit Grocers', CustomerSegment: 'Wholesale', IsActive: 1 },
    { CustomerId: 6, CustomerCode: 'C-006', CustomerName: 'Dormant Demo Account', CustomerSegment: 'Retail', IsActive: 0 },
  ]);

  await insertRows(connection, 'StoreLocation', ['StoreLocationId', 'LocationCode', 'LocationName'], [
    { StoreLocationId: 1, LocationCode: 'NORTH', LocationName: 'North Warehouse' },
    { StoreLocationId: 2, LocationCode: 'SOUTH', LocationName: 'South Store' },
    { StoreLocationId: 3, LocationCode: 'ONLINE', LocationName: 'Online Fulfillment' },
  ]);

  await insertRows(connection, 'DocumentType', ['DocumentTypeId', 'DocumentTypeName', 'DocumentTypeClass'], [
    { DocumentTypeId: 1, DocumentTypeName: 'Sales Invoice', DocumentTypeClass: 'Invoice' },
    { DocumentTypeId: 2, DocumentTypeName: 'Online Order', DocumentTypeClass: 'Order' },
    { DocumentTypeId: 3, DocumentTypeName: 'Credit Memo', DocumentTypeClass: 'Adjustment' },
    { DocumentTypeId: 4, DocumentTypeName: 'Store Receipt', DocumentTypeClass: 'Receipt' },
  ]);

  await insertRows(connection, 'LedgerAccount', ['LedgerAccountId', 'AccountCode', 'AccountName'], [
    { LedgerAccountId: 1, AccountCode: '4000', AccountName: 'Sales Revenue' },
    { LedgerAccountId: 2, AccountCode: '1100', AccountName: 'Accounts Receivable' },
    { LedgerAccountId: 3, AccountCode: '5000', AccountName: 'Cost Of Goods Sold' },
    { LedgerAccountId: 4, AccountCode: '2100', AccountName: 'Sales Tax Payable' },
  ]);

  await insertRows(connection, 'Product', ['ProductId', 'ProductCode', 'ProductName', 'ProductTags', 'ProductCategoryId', 'BrandId', 'CampaignId', 'IsActive'], [
    { ProductId: 1, ProductCode: 'BEV-SPARK-12', ProductName: 'Sparkling Water 12 Pack', ProductTags: 'seltzer carbonated fizzy water', ProductCategoryId: 1, BrandId: 1, CampaignId: 2, IsActive: 1 },
    { ProductId: 2, ProductCode: 'SNK-PRO-BOX', ProductName: 'Protein Bar Box', ProductTags: 'energy bar meal bar', ProductCategoryId: 2, BrandId: 2, CampaignId: 1, IsActive: 1 },
    { ProductId: 3, ProductCode: 'BEV-COLD-6', ProductName: 'Cold Brew Coffee 6 Pack', ProductTags: 'iced coffee ready to drink coffee', ProductCategoryId: 1, BrandId: 1, CampaignId: 2, IsActive: 1 },
    { ProductId: 4, ProductCode: 'SNK-TRAIL-1', ProductName: 'Trail Mix Pouch', ProductTags: 'nuts dried fruit snack', ProductCategoryId: 2, BrandId: 2, CampaignId: 3, IsActive: 1 },
    { ProductId: 5, ProductCode: 'PAN-RICE-5', ProductName: 'Long Grain Rice 5kg', ProductTags: 'pantry rice staple', ProductCategoryId: 3, BrandId: 3, CampaignId: 3, IsActive: 1 },
    { ProductId: 6, ProductCode: 'HH-TOWEL-4', ProductName: 'Kitchen Towels 4 Roll', ProductTags: 'household paper towels', ProductCategoryId: 4, BrandId: 4, CampaignId: 1, IsActive: 1 },
    { ProductId: 7, ProductCode: 'PAN-SUGAR-2', ProductName: 'Cane Sugar 2kg', ProductTags: 'pantry sugar baking', ProductCategoryId: 3, BrandId: 3, CampaignId: 3, IsActive: 1 },
    { ProductId: 8, ProductCode: 'BEV-TEA-20', ProductName: 'Herbal Tea Variety Pack', ProductTags: 'tea beverage', ProductCategoryId: 1, BrandId: 1, CampaignId: 1, IsActive: 1 },
  ]);

  await insertRows(connection, 'ProductBrand', ['ProductBrandId', 'ProductId', 'BrandId'], [
    { ProductBrandId: 1, ProductId: 1, BrandId: 1 },
    { ProductBrandId: 2, ProductId: 2, BrandId: 2 },
    { ProductBrandId: 3, ProductId: 3, BrandId: 1 },
    { ProductBrandId: 4, ProductId: 4, BrandId: 2 },
  ]);

  await insertRows(connection, 'SalesDocument', ['SalesDocumentId', 'DocumentNo', 'DocumentDate', 'PostingDate', 'DueDate', 'CustomerId', 'StoreLocationId', 'DocumentTypeId', 'CampaignId', 'IsCanceled', 'GrossAmount', 'NetAmount', 'NetPayableAmount', 'PaidAmount', 'BalanceAmount', 'SubtotalAmount', 'BillTotalAmount'], [
    { SalesDocumentId: 1, DocumentNo: 'SD-2026-0001', DocumentDate: '2026-03-05', PostingDate: '2026-03-06', DueDate: '2026-04-05', CustomerId: 1, StoreLocationId: 1, DocumentTypeId: 1, CampaignId: 2, IsCanceled: 0, GrossAmount: 1120, NetAmount: 1000, NetPayableAmount: 1000, PaidAmount: 750, BalanceAmount: 250, SubtotalAmount: 1050, BillTotalAmount: 1120 },
    { SalesDocumentId: 2, DocumentNo: 'SD-2026-0002', DocumentDate: '2026-03-10', PostingDate: '2026-03-10', DueDate: '2026-04-10', CustomerId: 2, StoreLocationId: 1, DocumentTypeId: 1, CampaignId: 2, IsCanceled: 0, GrossAmount: 880, NetAmount: 800, NetPayableAmount: 800, PaidAmount: 800, BalanceAmount: 0, SubtotalAmount: 830, BillTotalAmount: 880 },
    { SalesDocumentId: 3, DocumentNo: 'SD-2026-0003', DocumentDate: '2026-03-12', PostingDate: '2026-03-13', DueDate: '2026-04-12', CustomerId: 3, StoreLocationId: 3, DocumentTypeId: 2, CampaignId: 3, IsCanceled: 0, GrossAmount: 530, NetAmount: 500, NetPayableAmount: 500, PaidAmount: 300, BalanceAmount: 200, SubtotalAmount: 515, BillTotalAmount: 530 },
    { SalesDocumentId: 4, DocumentNo: 'SD-2026-0004', DocumentDate: '2026-02-20', PostingDate: '2026-02-21', DueDate: '2026-03-20', CustomerId: 1, StoreLocationId: 2, DocumentTypeId: 1, CampaignId: 3, IsCanceled: 0, GrossAmount: 760, NetAmount: 700, NetPayableAmount: 700, PaidAmount: 700, BalanceAmount: 0, SubtotalAmount: 730, BillTotalAmount: 760 },
    { SalesDocumentId: 5, DocumentNo: 'SD-2026-0005', DocumentDate: '2026-02-25', PostingDate: '2026-02-25', DueDate: '2026-03-25', CustomerId: 4, StoreLocationId: 2, DocumentTypeId: 4, CampaignId: 1, IsCanceled: 0, GrossAmount: 330, NetAmount: 300, NetPayableAmount: 300, PaidAmount: 300, BalanceAmount: 0, SubtotalAmount: 315, BillTotalAmount: 330 },
    { SalesDocumentId: 6, DocumentNo: 'SD-2026-0006', DocumentDate: '2026-03-15', PostingDate: '2026-03-15', DueDate: '2026-04-15', CustomerId: 4, StoreLocationId: 2, DocumentTypeId: 3, CampaignId: 1, IsCanceled: 1, GrossAmount: 220, NetAmount: 200, NetPayableAmount: 200, PaidAmount: 0, BalanceAmount: 200, SubtotalAmount: 210, BillTotalAmount: 220 },
    { SalesDocumentId: 7, DocumentNo: 'SD-2026-0007', DocumentDate: '2026-01-10', PostingDate: '2026-01-11', DueDate: '2026-02-10', CustomerId: 5, StoreLocationId: 1, DocumentTypeId: 1, CampaignId: 1, IsCanceled: 0, GrossAmount: 490, NetAmount: 450, NetPayableAmount: 450, PaidAmount: 450, BalanceAmount: 0, SubtotalAmount: 460, BillTotalAmount: 490 },
    { SalesDocumentId: 8, DocumentNo: 'SD-2026-0008', DocumentDate: '2026-03-18', PostingDate: '2026-03-19', DueDate: '2026-04-18', CustomerId: 5, StoreLocationId: 3, DocumentTypeId: 4, CampaignId: 3, IsCanceled: 0, GrossAmount: 700, NetAmount: 650, NetPayableAmount: 650, PaidAmount: 650, BalanceAmount: 0, SubtotalAmount: 675, BillTotalAmount: 700 },
    { SalesDocumentId: 9, DocumentNo: 'SD-2026-0009', DocumentDate: '2026-04-05', PostingDate: '2026-04-05', DueDate: '2026-05-05', CustomerId: 2, StoreLocationId: 1, DocumentTypeId: 1, CampaignId: 2, IsCanceled: 0, GrossAmount: 980, NetAmount: 900, NetPayableAmount: 900, PaidAmount: 0, BalanceAmount: 900, SubtotalAmount: 940, BillTotalAmount: 980 },
  ]);

  await insertRows(connection, 'SalesDocumentLine', ['SalesDocumentLineId', 'SalesDocumentId', 'ProductId', 'ProductNameSnapshot', 'Quantity', 'SalePrice', 'TotalAmount', 'NetAmount', 'CategoryNameSnapshot', 'BrandNameSnapshot'], [
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
  ]);

  await insertRows(connection, 'AccountingPosting', ['AccountingPostingId', 'SalesDocumentId', 'LedgerAccountId', 'PostingDate', 'DebitAmount', 'CreditAmount'], [
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
  ]);

  await insertRows(connection, 'CustomerProductPrice', ['CustomerProductPriceId', 'CustomerId', 'ProductId', 'SalePrice', 'EffectiveDate'], [
    { CustomerProductPriceId: 1, CustomerId: 1, ProductId: 1, SalePrice: 58, EffectiveDate: '2026-01-01' },
    { CustomerProductPriceId: 2, CustomerId: 2, ProductId: 3, SalePrice: 38, EffectiveDate: '2026-01-01' },
    { CustomerProductPriceId: 3, CustomerId: 4, ProductId: 2, SalePrice: 78, EffectiveDate: '2026-02-01' },
  ]);
}

async function main() {
  const argv = process.argv.slice(2);
  const envInfo = await loadEnvironment(argv);
  const connection = await createMariaDbConnection();
  try {
    await seedDemoDatabase(connection);
  } finally {
    await connection.end();
  }
  console.log('Seeded public demo database from ' + (envInfo.path || 'environment variables') + '.');
}

main().catch((error) => {
  console.error('Demo seed failed: ' + error.message);
  process.exitCode = 1;
});
