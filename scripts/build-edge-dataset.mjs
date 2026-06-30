// Build the public edge-case dataset from the core public cases plus the
// explicit public edge cases below. This keeps the checked-in fixture
// deterministic while preserving a real authoring surface for adding and
// regenerating public edge coverage.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corePath = path.resolve(ROOT, 'datasets/core-public.json');
const outPath = path.resolve(ROOT, 'datasets/edge-cases-public.json');

const PUBLIC_EDGE_CASES = [
  {
    "id": "edge_public_001_brand_net_sales_march_2026",
    "intentId": "brand_net_sales_march_2026",
    "question": "Show the top brands by net sales in March 2026.",
    "difficulty": "hard",
    "tags": [
      "retrieval",
      "join_path",
      "brand",
      "net_sales",
      "ranking"
    ],
    "failure_class": "wrong_join_path",
    "notes": "Brand linkage should use Product.BrandId -> Brand rather than stale SalesDocumentLine.BrandNameSnapshot.",
    "expected_sql": "SELECT b.BrandName, ROUND(SUM(COALESCE(l.NetAmount, 0)), 2) AS total_net_amount FROM SalesDocumentLine l JOIN SalesDocument d ON l.SalesDocumentId = d.SalesDocumentId JOIN Product p ON l.ProductId = p.ProductId JOIN Brand b ON p.BrandId = b.BrandId WHERE IFNULL(d.IsCanceled, 0) = 0 AND d.DocumentDate >= '2026-03-01' AND d.DocumentDate < '2026-04-01' GROUP BY b.BrandId, b.BrandName ORDER BY SUM(COALESCE(l.NetAmount, 0)) DESC, b.BrandName ASC LIMIT 10",
    "expected_tables": [
      "SalesDocumentLine",
      "SalesDocument",
      "Product",
      "Brand"
    ],
    "expected_columns": [
      "BrandName",
      "NetAmount"
    ],
    "disallowed_columns": [
      "BrandNameSnapshot",
      "ProductBrand"
    ],
    "comparison": {
      "mode": "ranked",
      "value_columns": [
        "total_net_amount"
      ],
      "order": "desc",
      "decimals": 2
    },
    "signal_checks": {
      "min_row_count": 3,
      "require_nonzero_columns": [
        "total_net_amount"
      ],
      "require_nonnull_columns": [
        "BrandName"
      ]
    },
    "expected_row_count": 3
  },
  {
    "id": "edge_public_002_campaign_net_sales_march_2026",
    "intentId": "campaign_net_sales_march_2026",
    "question": "What were the total sales for the Urban Refresh campaign in March 2026?",
    "difficulty": "hard",
    "tags": [
      "retrieval",
      "join_path",
      "campaign",
      "net_sales",
      "fuzzy"
    ],
    "failure_class": "campaign_join_path",
    "notes": "Campaign-filtered product sales should go SalesDocumentLine -> Product -> Campaign.",
    "expected_sql": "SELECT ROUND(SUM(COALESCE(l.NetAmount, 0)), 2) AS total_net_amount FROM SalesDocumentLine l JOIN SalesDocument d ON l.SalesDocumentId = d.SalesDocumentId JOIN Product p ON l.ProductId = p.ProductId JOIN Campaign c ON p.CampaignId = c.CampaignId WHERE c.CampaignName LIKE '%Urban Refresh%' AND IFNULL(d.IsCanceled, 0) = 0 AND d.DocumentDate >= '2026-03-01' AND d.DocumentDate < '2026-04-01'",
    "expected_tables": [
      "SalesDocumentLine",
      "SalesDocument",
      "Product",
      "Campaign"
    ],
    "expected_columns": [
      "CampaignName",
      "NetAmount"
    ],
    "disallowed_columns": [
      "SalesDocument.CampaignId"
    ],
    "comparison": {
      "mode": "scalar",
      "decimals": 2
    },
    "signal_checks": {
      "min_row_count": 1,
      "require_nonzero_columns": [
        "total_net_amount"
      ]
    },
    "expected_row_count": 1
  },
  {
    "id": "edge_public_003_sparkling_water_master_data",
    "intentId": "sparkling_water_master_data",
    "question": "Which sparkling water products did we sell in March 2026?",
    "difficulty": "medium",
    "tags": [
      "fuzzy",
      "product",
      "master_data"
    ],
    "failure_class": "master_data_resolution",
    "expected_sql": "SELECT DISTINCT p.ProductName FROM SalesDocumentLine l JOIN SalesDocument d ON l.SalesDocumentId = d.SalesDocumentId JOIN Product p ON l.ProductId = p.ProductId WHERE (p.ProductName LIKE '%sparkling water%' OR p.ProductTags LIKE '%seltzer%' OR p.ProductTags LIKE '%carbonated water%') AND IFNULL(d.IsCanceled, 0) = 0 AND d.DocumentDate >= '2026-03-01' AND d.DocumentDate < '2026-04-01' ORDER BY p.ProductName",
    "expected_tables": [
      "SalesDocumentLine",
      "SalesDocument",
      "Product"
    ],
    "expected_columns": [
      "ProductName",
      "ProductTags",
      "DocumentDate"
    ],
    "comparison": {
      "mode": "rowset",
      "compare_columns": [
        "ProductName"
      ]
    },
    "signal_checks": {
      "min_row_count": 1,
      "require_nonnull_columns": [
        "ProductName"
      ]
    },
    "expected_row_count": 1
  },
  {
    "id": "edge_public_004_posting_date_trap",
    "intentId": "posting_date_document_count",
    "question": "How many sales documents were posted in March 2026?",
    "difficulty": "medium",
    "tags": [
      "temporal",
      "posting_date"
    ],
    "failure_class": "wrong_date_column",
    "expected_sql": "SELECT COUNT(*) AS document_count FROM SalesDocument d WHERE IFNULL(d.IsCanceled, 0) = 0 AND d.PostingDate >= '2026-03-01' AND d.PostingDate < '2026-04-01'",
    "expected_tables": [
      "SalesDocument"
    ],
    "expected_columns": [
      "PostingDate"
    ],
    "disallowed_columns": [
      "DueDate"
    ],
    "comparison": {
      "mode": "scalar"
    },
    "signal_checks": {
      "min_row_count": 1,
      "require_nonzero_columns": [
        "document_count"
      ]
    },
    "expected_row_count": 1
  },
  {
    "id": "edge_public_005_customer_gross_amount_march_2026",
    "intentId": "customer_gross_amount_march_2026",
    "question": "Show the top customers by gross amount in March 2026.",
    "difficulty": "hard",
    "tags": [
      "metric_confusion",
      "customer",
      "ranking",
      "temporal"
    ],
    "failure_class": "metric_column_confusion",
    "notes": "Gross amount questions should use SalesDocument.GrossAmount, not NetAmount, NetPayableAmount, or BillTotalAmount.",
    "expected_sql": "SELECT c.CustomerName, ROUND(SUM(COALESCE(d.GrossAmount, 0)), 2) AS total_gross_amount FROM SalesDocument d JOIN Customer c ON d.CustomerId = c.CustomerId WHERE IFNULL(d.IsCanceled, 0) = 0 AND d.DocumentDate >= '2026-03-01' AND d.DocumentDate < '2026-04-01' GROUP BY c.CustomerId, c.CustomerName ORDER BY SUM(COALESCE(d.GrossAmount, 0)) DESC, c.CustomerName ASC LIMIT 10",
    "expected_tables": [
      "SalesDocument",
      "Customer"
    ],
    "expected_columns": [
      "GrossAmount",
      "DocumentDate",
      "CustomerName"
    ],
    "disallowed_columns": [
      "NetPayableAmount",
      "BillTotalAmount"
    ],
    "comparison": {
      "mode": "ranked",
      "value_columns": [
        "total_gross_amount"
      ],
      "order": "desc",
      "decimals": 2
    },
    "signal_checks": {
      "min_row_count": 4,
      "require_nonzero_columns": [
        "total_gross_amount"
      ],
      "require_nonnull_columns": [
        "CustomerName"
      ],
      "min_distinct_counts": {
        "CustomerName": 4
      }
    },
    "expected_row_count": 4
  },
  {
    "id": "edge_public_006_category_line_net_sales_march_2026",
    "intentId": "category_line_net_sales_march_2026",
    "question": "Show net sales by product category in March 2026.",
    "difficulty": "hard",
    "tags": [
      "grain_confusion",
      "product_category",
      "line_net_sales",
      "temporal"
    ],
    "failure_class": "grain_confusion",
    "notes": "Product-category sales must aggregate SalesDocumentLine.NetAmount at line grain, not header NetAmount.",
    "expected_sql": "SELECT pc.CategoryName, ROUND(SUM(COALESCE(l.NetAmount, 0)), 2) AS total_net_amount FROM SalesDocumentLine l JOIN SalesDocument d ON l.SalesDocumentId = d.SalesDocumentId JOIN Product p ON l.ProductId = p.ProductId JOIN ProductCategory pc ON p.ProductCategoryId = pc.ProductCategoryId WHERE IFNULL(d.IsCanceled, 0) = 0 AND d.DocumentDate >= '2026-03-01' AND d.DocumentDate < '2026-04-01' GROUP BY pc.ProductCategoryId, pc.CategoryName ORDER BY SUM(COALESCE(l.NetAmount, 0)) DESC, pc.CategoryName ASC",
    "expected_tables": [
      "SalesDocumentLine",
      "SalesDocument",
      "Product",
      "ProductCategory"
    ],
    "expected_columns": [
      "CategoryName",
      "NetAmount",
      "DocumentDate"
    ],
    "disallowed_columns": [
      "CategoryNameSnapshot",
      "GrossAmount",
      "BillTotalAmount",
      "NetPayableAmount"
    ],
    "comparison": {
      "mode": "ranked",
      "value_columns": [
        "total_net_amount"
      ],
      "order": "desc",
      "decimals": 2
    },
    "signal_checks": {
      "min_row_count": 3,
      "require_nonzero_columns": [
        "total_net_amount"
      ],
      "require_nonnull_columns": [
        "CategoryName"
      ]
    },
    "expected_row_count": 3
  },
  {
    "id": "edge_public_007_category_quantity_current_join",
    "intentId": "category_quantity_current_join",
    "question": "Which product categories had the highest quantity sold in March 2026?",
    "difficulty": "hard",
    "tags": [
      "stale_snapshot",
      "product_category",
      "quantity",
      "ranking"
    ],
    "failure_class": "stale_snapshot_field",
    "notes": "Category analysis should join ProductCategory through Product instead of using SalesDocumentLine.CategoryNameSnapshot.",
    "expected_sql": "SELECT pc.CategoryName, ROUND(SUM(COALESCE(l.Quantity, 0)), 3) AS total_qty FROM SalesDocumentLine l JOIN SalesDocument d ON l.SalesDocumentId = d.SalesDocumentId JOIN Product p ON l.ProductId = p.ProductId JOIN ProductCategory pc ON p.ProductCategoryId = pc.ProductCategoryId WHERE IFNULL(d.IsCanceled, 0) = 0 AND d.DocumentDate >= '2026-03-01' AND d.DocumentDate < '2026-04-01' GROUP BY pc.ProductCategoryId, pc.CategoryName ORDER BY SUM(COALESCE(l.Quantity, 0)) DESC, pc.CategoryName ASC LIMIT 10",
    "expected_tables": [
      "SalesDocumentLine",
      "SalesDocument",
      "Product",
      "ProductCategory"
    ],
    "expected_columns": [
      "CategoryName",
      "Quantity",
      "DocumentDate"
    ],
    "disallowed_columns": [
      "CategoryNameSnapshot"
    ],
    "comparison": {
      "mode": "ranked",
      "value_columns": [
        "total_qty"
      ],
      "order": "desc",
      "decimals": 3
    },
    "signal_checks": {
      "min_row_count": 3,
      "require_nonzero_columns": [
        "total_qty"
      ],
      "require_nonnull_columns": [
        "CategoryName"
      ]
    },
    "expected_row_count": 3
  },
  {
    "id": "edge_public_008_customer_month_columns_jan_feb_2026",
    "intentId": "customer_month_columns_jan_feb_2026",
    "question": "Compare January and February 2026 net sales by customer in separate columns.",
    "difficulty": "hard",
    "tags": [
      "aggregation_shape",
      "temporal",
      "customer",
      "net_sales"
    ],
    "failure_class": "aggregation_shape",
    "notes": "Comparison requests for separate months should render conditional aggregate columns rather than one long grouped month rowset.",
    "expected_sql": "SELECT c.CustomerName, ROUND(SUM(CASE WHEN d.DocumentDate >= '2026-01-01' AND d.DocumentDate < '2026-02-01' THEN COALESCE(d.NetAmount, 0) ELSE 0 END), 2) AS jan_net_amount, ROUND(SUM(CASE WHEN d.DocumentDate >= '2026-02-01' AND d.DocumentDate < '2026-03-01' THEN COALESCE(d.NetAmount, 0) ELSE 0 END), 2) AS feb_net_amount FROM SalesDocument d JOIN Customer c ON d.CustomerId = c.CustomerId WHERE IFNULL(d.IsCanceled, 0) = 0 AND d.DocumentDate >= '2026-01-01' AND d.DocumentDate < '2026-03-01' GROUP BY c.CustomerId, c.CustomerName ORDER BY c.CustomerName ASC",
    "expected_tables": [
      "SalesDocument",
      "Customer"
    ],
    "expected_columns": [
      "CustomerName",
      "DocumentDate",
      "NetAmount"
    ],
    "comparison": {
      "mode": "rowset",
      "compare_columns": [
        "CustomerName",
        "jan_net_amount",
        "feb_net_amount"
      ],
      "decimals": 2
    },
    "signal_checks": {
      "min_row_count": 3,
      "require_nonnull_columns": [
        "CustomerName"
      ]
    },
    "expected_row_count": 3
  }
];

const coreCases = JSON.parse(await fs.readFile(corePath, 'utf8'));
const edgeCases = [...coreCases, ...PUBLIC_EDGE_CASES];
await fs.writeFile(outPath, `${JSON.stringify(edgeCases, null, 2)}\n`, 'utf8');
console.log(`Public edge-case dataset written to ${outPath} (${edgeCases.length} cases).`);
