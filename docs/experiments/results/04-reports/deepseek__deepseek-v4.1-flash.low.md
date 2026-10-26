# Evaluation report: all · deepseek/deepseek-v4.1-flash (reasoning effort low)

**Strict accuracy 91.2%** (every split; no interval while the holdout is hidden) · 392 cases · 3 repetitions · deepseek/deepseek-v4.1-flash (reasoning effort low) · 2026-10-14 13:54:47 UTC

Dev cases: strict accuracy 95.2% (95% CI 92.4%–97.7%, case bootstrap) over 245 cases · majority-pass cases 233/245 (Wilson 95% 91.6%–97.2%) · intent-clustered accuracy 95.1% (95% CI 91.4%–98.2%, 130 intents)

By split: dev 95.2% (245 cases) · holdout 84.4% (147 cases). Dev cases include the wording the prompt rules and the semantic layer were tuned on; holdout cases are new intents whose questions contain no multi-word phrase of the semantic layer and not the tuned word "revenue" (single words such as customer, store or units still match it).

Holdout: 149 case(s), shown in aggregate only (accuracy by split); error analysis and experiment design use dev failures only (the intervals, majority-pass cases, intent-clustered accuracy, attribution, the guardrail matrix, behaviour cases, cost, latency, the finer breakdowns and the pooled rate cover dev cases). `--reveal-holdout` lists them.

Behaviour cases: abstain/clarify — 10 cases, 0 handled correctly. Not counted here: 2 holdout abstain/clarify case(s), outcomes not shown. Not in strict accuracy (see Behaviour cases).

vs baseline (dev cases): Δ +1.2 pts (95% CI −0.8 pts to +3.4 pts) on 245 paired dev case(s); 4 regression(s), 5 improvement(s); exact McNemar p = 1.000 → no significant difference from the baseline (the comparison's 147 holdout case(s) are not shown; --gate tests every paired case)

## Attribution

Who caused each outcome. Repetitions are every (case, repetition) run; cases use each case's majority outcome. Excluded outcomes are not in the accuracy denominator. Dev cases only: the 147 holdout answer case(s) are shown in aggregate (accuracy by split).

| Bucket | Repetitions | Cases (majority) |
| --- | --- | --- |
| pass | 700 | 233 |
| model errors | 35 | 12 |

| Outcome | Bucket | Repetitions | Cases (majority) | In accuracy |
| --- | --- | --- | --- | --- |
| wrong_result | model | 35 | 12 | counted |
| pass | pass | 700 | 233 | counted |

System errors (counted repetitions): 0 guardrail false rejection(s), 0 retrieval miss(es) (a failure where an expected table was not retrieved, so not allowed), 0 known validator rejection(s) (a case flagged known_validator_rejection whose final attempt the validator rejected with the flagged code: it rejects every correct answer to that question today; any other failure of a flagged case is judged as usual). A model-bucket failure tagged retrieval_miss or known_validator_rejection is counted as a system error.

Excluded from accuracy: 10 abstain/clarify cases (30 repetitions; see Behaviour cases); 2 holdout abstain/clarify case(s) (not listed).

## Guardrail confusion matrix

Every attempt, retries included. "Rejected" = a guardrail-layer rejection; correctness of rejected SQL is decided by re-running it read-only on every fixture (only after it passes the safety layer). An accepted attempt that failed at execution counts as incorrect. Dev cases only (the holdout is shown in aggregate, by split).

|  | SQL correct | SQL incorrect |
| --- | --- | --- |
| Rejected by a guardrail | 1 (false rejection) | 6 (caught) |
| Accepted | 700 | 35 (missed) |

Precision 85.7% · recall 14.6% · false rejection rate 0.1% · unknown 0 · safety-layer rejections (never run) 0 · attempts 742

## Comparison with the baseline

Dev cases only: the comparison's 147 holdout case(s) are left out of these figures and lists (the holdout is read as its accuracy by split). `--gate` still tests every paired case, holdout included; its verdict is the exit code. `--reveal-holdout` shows them.

|  | Baseline | Candidate |
| --- | --- | --- |
| Report | eval/baselines/gpt-6-luna.low.json | this run |
| Model | gpt-6-luna | deepseek/deepseek-v4.1-flash |
| Reasoning effort | low | low |
| Request options | max_completion_tokens 16000, reasoning_effort low | max_tokens 16000, reasoning {"enabled":true,"effort":"low"}, provider {"require_parameters":true} |
| Generated | 2026-10-07T07:26:08.358Z | 2026-10-14T13:54:47.011Z |
| Git | a57fa44d42 | 717ec520a3 (dirty) |
| Prompt version | 4358263bcf82 | 4358263bcf82 |
| Schema scope | auto -> full (2,258 of 8,000 estimated tokens for the full schema; 13 in-scope tables) | auto -> full (2,258 of 8,000 estimated tokens for the full schema; 13 in-scope tables) |
| Hints version | 2 (default) | 2 (default) |
| Strict accuracy (paired dev cases) | 94.0% | 95.2% |
| Majority passes (paired dev cases) | 232/245 | 233/245 |

**Model change:** the baseline ran gpt-6-luna (reasoning effort low) and the candidate deepseek/deepseek-v4.1-flash (reasoning effort low), so the paired comparison measures the model change, not only a product change.

Paired majority verdicts (the exact McNemar test uses the off-diagonal cells):

|  | Candidate pass | Candidate fail |
| --- | --- | --- |
| Baseline pass | 228 | 4 (regressions) |
| Baseline fail | 5 (improvements) | 8 |

vs baseline (dev cases): Δ +1.2 pts (95% CI −0.8 pts to +3.4 pts) on 245 paired dev case(s); 4 regression(s), 5 improvement(s); exact McNemar p = 1.000 → no significant difference from the baseline (the comparison's 147 holdout case(s) are not shown; --gate tests every paired case)

Holdout in aggregate (`--holdout-summary`): 147 paired holdout case(s); 10 improvement(s), 6 regression(s); exact McNemar p = 0.454 → no significant difference from the baseline; strict accuracy 81.6% → 84.4%, Δ +2.7 pts (95% CI −1.4 pts to +7.0 pts).

### Regressions (baseline majority pass → candidate fail)

| Case | Question | Baseline | Candidate |
| --- | --- | --- | --- |
| tpl_doctype_outstanding_balance_feb_2026_0a4e2a | Open balance by document type for February 2026. | 100% (pass) | 33% (wrong_result) |
| tpl_net_sales_metro_online_store_q1_2026_a1c3e1 | How much did Metro Online Store buy from us (net)… | 67% (pass) | 0% (wrong_result) |
| tpl_north_district_document_count_q1_2026_c55b7e | Number of sales documents for North District Mark… | 100% (pass) | 0% (wrong_result) |
| tpl_sunvale_net_sales_monthly_q1_2026_002849 | Monthly net sales of Sunvale Foods products in Q1… | 100% (pass) | 0% (wrong_result) |

### Improvements (baseline fail → candidate majority pass)

| Case | Question | Baseline | Candidate |
| --- | --- | --- | --- |
| paraphrase_public_002 | Which SKUs moved the most in March 2026? | 33% (wrong_result) | 100% (pass) |
| tpl_category_distinct_customers_mar_2026_cd96b8 | For March 2026, count the distinct buyers of ever… | 0% (wrong_result) | 100% (pass) |
| tpl_product_net_sales_top5_online_fulfillment_mar_2026_288feb | Which five products earned the most revenue throu… | 33% (wrong_result) | 100% (pass) |
| tpl_product_qty_top5_feb_2026_8a9dc1 | Which five SKUs moved the most units in February … | 0% (wrong_result) | 100% (pass) |
| tpl_store_qty_mar_2026_651565 | How many units left each of our locations in Marc… | 33% (wrong_result) | 100% (pass) |

### Pass-rate changes without a flip

| Case | Question | Baseline | Candidate |
| --- | --- | --- | --- |
| tpl_account_posting_count_mar_2026_9b1a49 | How many postings hit each ledger account in Marc… | 67% (pass) | 100% (pass) |
| tpl_category_net_sales_q1_2025_de597f | Break down first-quarter 2025 net takings by cate… | 67% (pass) | 100% (pass) |
| tpl_customer_net_sales_apr_2026_db0b51 | How much did each customer spend with us in April… | 67% (pass) | 100% (pass) |
| tpl_doctype_net_sales_top1_may_2026_3621b4 | In May 2026, what kind of document carried the hi… | 67% (pass) | 100% (pass) |
| tpl_document_count_monthly_2026_891aba | How many documents did we record in each month of… | 67% (pass) | 100% (pass) |
| tpl_outstanding_balance_monthly_q1_2026_59ffde | Outstanding balance by document month for Q1 2026. | 67% (pass) | 100% (pass) |
| tpl_store_canceled_value_q1_2026_570e8b | For each store, how many documents were canceled … | 67% (pass) | 100% (pass) |

## Behaviour cases (abstain / clarify)

Behaviour cases: abstain/clarify — 10 cases, 0 handled correctly. Not counted here: 2 holdout abstain/clarify case(s), outcomes not shown.

These questions have no correct SQL: the data cannot answer them (abstain) or they are ambiguous (clarify). A case is handled when the product returned no SQL in more than half of its counted repetitions (`declined`); producing SQL is `answered_instead_of_abstain` / `answered_instead_of_clarify` (model bucket, tagged `not_executed` when the SQL was rejected or failed). The product has no abstention or clarification channel yet, so today it is expected to fail these. They are not in strict accuracy or the paired comparison.

| Expected behaviour | Cases | Handled | Outcomes (majority) |
| --- | --- | --- | --- |
| clarify | 5 | 0/5 | answered_instead_of_clarify 5 |
| abstain | 5 | 0/5 | answered_instead_of_abstain 5 |

| Case | Question | Expects | Declined | Outcome |
| --- | --- | --- | --- | --- |
| hard_clarify_summit_grocers_mar_2026 | How much did Summit Grocers buy in March 2026? | clarify | 0/3 declined | answered_instead_of_clarify |
| hard_abstain_employee_headcount_by_store | What is our employee headcount by store? | abstain | 0/3 declined | answered_instead_of_abstain |
| hard_abstain_weather_on_peak_day | What was the weather in Stockholm on the day our sales peak… | abstain | 0/3 declined | answered_instead_of_abstain |
| hard_abstain_sales_forecast_jul_2026 | Forecast our net sales for July 2026. | abstain | 0/3 declined | answered_instead_of_abstain |
| hard_abstain_competitor_prices | Which competitors sell the same products cheaper than we do? | abstain | 0/3 declined | answered_instead_of_abstain |
| hard_abstain_customer_satisfaction | What is the customer satisfaction score for Lakeside Wholes… | abstain | 0/3 declined | answered_instead_of_abstain |
| hard_clarify_sales_last_month | Show sales for last month. | clarify | 0/3 declined | answered_instead_of_clarify |
| hard_clarify_best_customer | Who is our best customer? | clarify | 0/3 declined | answered_instead_of_clarify |
| hard_clarify_south_store_performance | How is the South Store doing? | clarify | 0/3 declined | answered_instead_of_clarify |
| hard_clarify_this_year_vs_last_year | Compare this year with last year. | clarify | 0/3 declined | answered_instead_of_clarify |

2 holdout behaviour case(s) not listed and not in these counts: holdout results are read in aggregate only, and the behaviour cases are not in the split accuracy, so their outcomes are not shown; pass --reveal-holdout to list them.

## Cases

| Case | Question | Passes | Outcome | Attribution |
| --- | --- | --- | --- | --- |
| core_public_001 | Show the top customers by total net sales amount in March 2… | 3/3 | pass | pass |
| core_public_002 | Show the top products by quantity sold in March 2026. | 3/3 | pass | pass |
| core_public_003 | Show sales document count by document type in March 2026. | 3/3 | pass | pass |
| core_public_004 | How many products were sold in February 2026 but not in Mar… | 3/3 | pass | pass |
| core_public_005 | Show the top ledger accounts by debit amount in March 2026. | 0/3 | wrong_result | model |
| core_public_006 | How many non-canceled sales documents do not have any accou… | 3/3 | pass | pass |
| core_public_007 | How many active customers do we have? | 3/3 | pass | pass |
| core_public_008 | Show the top products by net sales amount in March 2026. | 3/3 | pass | pass |
| core_public_009 | Show the top ledger accounts by credit amount in March 2026. | 0/3 | wrong_result | model |
| edge_public_001_brand_net_sales_march_2026 | Show the top brands by net sales in March 2026. | 3/3 | pass | pass |
| edge_public_002_campaign_net_sales_march_2026 | What were the total sales for the Urban Refresh campaign in… | 3/3 | pass | pass |
| edge_public_003_sparkling_water_master_data | Which sparkling water products did we sell in March 2026? | 3/3 | pass | pass |
| edge_public_004_posting_date_trap | How many sales documents were posted in March 2026? | 3/3 | pass | pass |
| edge_public_005_customer_gross_amount_march_2026 | Show the top customers by gross amount in March 2026. | 3/3 | pass | pass |
| edge_public_006_category_line_net_sales_march_2026 | Show net sales by product category in March 2026. | 3/3 | pass | pass |
| edge_public_007_category_quantity_current_join | Which product categories had the highest quantity sold in M… | 3/3 | pass | pass |
| edge_public_008_customer_month_columns_jan_feb_2026 | Compare January and February 2026 net sales by customer in … | 3/3 | pass | pass |
| hard_vocab_outlet_turnover_top1_mar_2026 | Which outlet had the highest turnover in March 2026? | 3/3 | pass | pass |
| hard_vocab_debtors_owe_q1_2026 | How much do our debtors still owe us for sales made in Q1 2… | 3/3 | pass | pass |
| hard_vocab_department_turnover_feb_2026 | Show turnover by department for February 2026. | 3/3 | pass | pass |
| hard_vocab_shoppers_apr_2026 | How many distinct shoppers made a purchase in April 2026? | 3/3 | pass | pass |
| hard_vocab_receivables_by_outlet_mar_2026 | What is the receivables position by outlet for March 2026 s… | 3/3 | pass | pass |
| hard_sv_top_customers_net_sales_mar_2026 | Visa de största kunderna efter nettoförsäljning i mars 2026. | 3/3 | pass | pass |
| hard_sv_active_customer_count | Hur många aktiva kunder har vi? | 3/3 | pass | pass |
| hard_sv_products_most_units_mar_2026 | Vilka är de tio produkter som sålde flest enheter i mars 20… | 3/3 | pass | pass |
| hard_mixed_brand_net_sales_mar_2026 | Visa net sales per varumärke för March 2026, störst först. | 3/3 | pass | pass |
| hard_sv_documents_by_type_mar_2026 | Antal försäljningsdokument per dokumenttyp i mars 2026? | 3/3 | pass | pass |
| hard_typo_top_customers_mar_2026 | top custmers by net sales in Mrach 2026 | 3/3 | pass | pass |
| hard_typo_ar_balance_by_store_mar_2026 | AR bal by store mar 2026 | 3/3 | pass | pass |
| hard_typo_qty_by_category_feb_2026 | qty sold by catgory feb 2026 | 3/3 | pass | pass |
| hard_typo_rev_by_brand_q1_2026 | rev by brnd Q1 26 | 3/3 | pass | pass |
| hard_asof_last_month_net_sales | As of 2026-04-01, what were last month's net sales? | 3/3 | pass | pass |
| hard_asof_month_to_date_documents | Today is 15 February 2026. How many sales documents have we… | 3/3 | pass | pass |
| hard_asof_previous_quarter_units_by_category | As of 2026-05-10, how many units did each category sell in … | 3/3 | pass | pass |
| hard_asof_last_calendar_year_net_sales | Assume today is 2026-01-05. What were our total net sales l… | 3/3 | pass | pass |
| hard_asof_year_to_date_gross | As of 31 March 2026, what's our year-to-date gross amount? | 3/3 | pass | pass |
| hard_entity_lakeside_spend_q1_2026 | How much did Lakeside Wholesale spend with us in Q1 2026? | 3/3 | pass | pass |
| hard_entity_weekend_pantry_units_feb_2026 | How many units of Weekend Pantry campaign products did we s… | 3/3 | pass | pass |
| hard_entity_clearspring_units_mar_2026 | How many units of Clearspring Waters products did we sell i… | 0/3 | wrong_result | model |
| hard_entity_sales_revenue_credits_feb_2026 | Total credits posted to the Sales Revenue account in Februa… | 3/3 | pass | pass |
| hard_entity_summit_grocers_by_code_mar_2026 | List the March 2026 net takings of each customer named Summ… | 3/3 | pass | pass |
| hard_clarify_summit_grocers_mar_2026 | How much did Summit Grocers buy in March 2026? | 0/3 declined | answered_instead_of_clarify | expects clarify, model |
| hard_zero_customers_jun_2026 | Show net sales by customer for June 2026. | 3/3 | pass | pass |
| hard_zero_total_net_sales_2023 | What were total net sales in 2023? | 3/3 | pass | pass |
| hard_zero_harbor_kiosk_products_mar_2026 | Which products did Harbor Kiosk buy in March 2026? | 3/3 | pass | pass |
| hard_zero_harbor_kiosk_credit_notes_2026 | How many credit notes did Harbor Kiosk receive in 2026? | 3/3 | pass | pass |
| hard_abstain_employee_headcount_by_store | What is our employee headcount by store? | 0/3 declined | answered_instead_of_abstain | expects abstain, model |
| hard_abstain_weather_on_peak_day | What was the weather in Stockholm on the day our sales peak… | 0/3 declined | answered_instead_of_abstain | expects abstain, model |
| hard_abstain_sales_forecast_jul_2026 | Forecast our net sales for July 2026. | 0/3 declined | answered_instead_of_abstain | expects abstain, model |
| hard_abstain_competitor_prices | Which competitors sell the same products cheaper than we do? | 0/3 declined | answered_instead_of_abstain | expects abstain, model |
| hard_abstain_customer_satisfaction | What is the customer satisfaction score for Lakeside Wholes… | 0/3 declined | answered_instead_of_abstain | expects abstain, model |
| hard_clarify_sales_last_month | Show sales for last month. | 0/3 declined | answered_instead_of_clarify | expects clarify, model |
| hard_clarify_best_customer | Who is our best customer? | 0/3 declined | answered_instead_of_clarify | expects clarify, model |
| hard_clarify_south_store_performance | How is the South Store doing? | 0/3 declined | answered_instead_of_clarify | expects clarify, model |
| hard_clarify_this_year_vs_last_year | Compare this year with last year. | 0/3 declined | answered_instead_of_clarify | expects clarify, model |
| hard_ambiguous_sales_mar_2026 | What were sales in March 2026? | 3/3 | pass | pass |
| hard_ambiguous_orders_mar_2026 | How many orders did we get in March 2026? | 3/3 | pass | pass |
| paraphrase_public_001 | Who are our biggest buyers in March 2026? | 3/3 | pass | pass |
| paraphrase_public_002 | Which SKUs moved the most in March 2026? | 3/3 | pass | pass |
| paraphrase_public_003 | Which document classes were used the most in March 2026? | 3/3 | pass | pass |
| paraphrase_public_004 | How many SKUs sold in February 2026 but stopped selling in … | 3/3 | pass | pass |
| paraphrase_public_005 | Which general ledger accounts had the biggest debits in Mar… | 0/3 | wrong_result | model |
| paraphrase_public_006 | How many sales documents never made it into accounting post… | 3/3 | pass | pass |
| paraphrase_public_007 | What's our active customer headcount? | 3/3 | pass | pass |
| paraphrase_public_008 | Which products brought in the most revenue in March 2026? | 3/3 | pass | pass |
| paraphrase_public_009 | Top general-ledger accounts by credit in March 2026. | 0/3 | wrong_result | model |
| tpl_customer_net_sales_top3_feb_2026_0bded9 | Which three customers generated the most net sales in Febru… | 3/3 | pass | pass |
| tpl_customer_net_sales_top3_feb_2026_a470e9 | Top 3 customers by net revenue for February 2026. | 3/3 | pass | pass |
| tpl_customer_net_sales_top3_feb_2026_4cc7ef | Name our three largest customers by net sales value in Febr… | 3/3 | pass | pass |
| tpl_customer_net_sales_top5_q1_2026_483331 | Who were our top 5 customers by turnover in Q1 2026? | 3/3 | pass | pass |
| tpl_customer_net_sales_top5_q1_2026_e88290 | Rank customers by net amount billed for January through Mar… | 3/3 | pass | pass |
| tpl_customer_net_sales_apr_2026_71a102 | Net takings per customer in April 2026. | 3/3 | pass | pass |
| tpl_customer_net_sales_apr_2026_db0b51 | How much did each customer spend with us in April 2026, exc… | 3/3 | pass | pass |
| tpl_customer_net_sales_top3_dec_2025_6c6fbf | Top three customers by net sales in December 2025. | 3/3 | pass | pass |
| tpl_customer_net_sales_top3_dec_2025_a5de34 | Which 3 clients spent the most with us in December 2025, me… | 3/3 | pass | pass |
| tpl_customer_net_sales_rank_nov_2025_3b56b4 | Rank the customers who bought from us in November 2025 by n… | 3/3 | pass | pass |
| tpl_customer_net_sales_rank_nov_2025_e23a54 | List the November 2025 buyers from highest to lowest net am… | 3/3 | pass | pass |
| tpl_doctype_net_sales_q1_2026_c03c7d | Turnover by type of document for Q1 2026. | 3/3 | pass | pass |
| tpl_doctype_net_sales_q1_2026_f92ec1 | Break down first-quarter 2026 net takings by kind of docume… | 3/3 | pass | pass |
| tpl_doctype_net_sales_top1_may_2026_ec6b39 | Which document type brought in the most net sales in May 20… | 3/3 | pass | pass |
| tpl_doctype_net_sales_top1_may_2026_3621b4 | In May 2026, what kind of document carried the highest net … | 3/3 | pass | pass |
| tpl_total_net_sales_feb_2026_ddd37d | What were total net sales in February 2026? | 3/3 | pass | pass |
| tpl_total_net_sales_feb_2026_09daf2 | How much net revenue did we make in February 2026? | 3/3 | pass | pass |
| tpl_total_net_sales_q4_2025_ae91e0 | Total net sales for Q4 2025? | 3/3 | pass | pass |
| tpl_total_net_sales_q4_2025_eb94b6 | What net revenue did we make in the last quarter of 2025? | 3/3 | pass | pass |
| tpl_total_net_sales_2025_0b12d5 | What were our net sales for the whole of 2025? | 3/3 | pass | pass |
| tpl_total_net_sales_2025_2881e4 | Total net revenue in calendar year 2025. | 3/3 | pass | pass |
| tpl_total_net_sales_feb15_mar15_2026_40ae9d | What was our turnover from 15 February 2026 through 15 Marc… | 3/3 | pass | pass |
| tpl_total_net_sales_feb15_mar15_2026_ad37a4 | Net takings between Feb 15 and Mar 15, 2026 (inclusive). | 3/3 | pass | pass |
| tpl_net_sales_monthly_q1_2026_561627 | Show turnover month by month for Q1 2026. | 3/3 | pass | pass |
| tpl_net_sales_monthly_q1_2026_1fff6f | Monthly net takings for January to March 2026. | 3/3 | pass | pass |
| tpl_net_sales_monthly_nov_2025_feb_2026_23a39e | Turnover per month from November 2025 through February 2026. | 3/3 | pass | pass |
| tpl_net_sales_monthly_nov_2025_feb_2026_14397f | How did monthly takings, net of tax, develop between Novemb… | 3/3 | pass | pass |
| tpl_net_sales_by_year_da86ca | Net sales by year. | 3/3 | pass | pass |
| tpl_net_sales_by_year_08186a | Show total net revenue per calendar year. | 3/3 | pass | pass |
| tpl_customer_net_sales_q1_2025_vs_q1_2026_1479d7 | Compare net sales by customer for Q1 2025 and Q1 2026 in tw… | 3/3 | pass | pass |
| tpl_customer_net_sales_q1_2025_vs_q1_2026_d99d9e | For each customer, show first-quarter 2025 net revenue next… | 3/3 | pass | pass |
| tpl_net_sales_march_2025_vs_march_2026_f34a42 | Show March 2025 and March 2026 turnover side by side. | 3/3 | pass | pass |
| tpl_net_sales_march_2025_vs_march_2026_423088 | Put total net takings for March 2025 next to March 2026 in … | 3/3 | pass | pass |
| tpl_customer_net_sales_north_warehouse_q1_2026_f51899 | Net sales per customer at the North Warehouse in Q1 2026. | 3/3 | pass | pass |
| tpl_customer_net_sales_north_warehouse_q1_2026_744569 | For the North Warehouse location, how much net revenue came… | 3/3 | pass | pass |
| tpl_net_sales_south_store_mar_2026_ff1f77 | What was turnover at the South Store in March 2026? | 3/3 | pass | pass |
| tpl_net_sales_south_store_mar_2026_4dd0d0 | How much did South Store take in March 2026, net of tax? | 3/3 | pass | pass |
| tpl_customer_net_sales_sales_invoices_mar_2026_a6dc03 | Net sales per customer from Sales Invoice documents in Marc… | 3/3 | pass | pass |
| tpl_customer_net_sales_sales_invoices_mar_2026_47c26d | Counting only documents of type Sales Invoice, what did eac… | 3/3 | pass | pass |
| tpl_net_sales_online_orders_monthly_2026_22ecc5 | Monthly net sales from Online Order documents in 2026. | 3/3 | pass | pass |
| tpl_net_sales_online_orders_monthly_2026_25aa4c | How much net revenue came in through online orders each mon… | 0/3 | wrong_result | model |
| tpl_net_sales_metro_online_store_q1_2026_a1c3e1 | How much did Metro Online Store buy from us (net) in Q1 202… | 0/3 | wrong_result | model |
| tpl_net_sales_metro_online_store_q1_2026_87a58f | Turnover from Metro Online Store for the first quarter of 2… | 0/3 | wrong_result | model |
| tpl_net_sales_by_customer_and_store_mar_2026_7ea991 | Turnover by customer and store location for March 2026. | 3/3 | pass | pass |
| tpl_net_sales_by_customer_and_store_mar_2026_c04623 | Split March 2026 net takings by customer and by the locatio… | 3/3 | pass | pass |
| tpl_customer_net_sales_top3_jan_2026_e2fa20 | Top 3 customers by net sales for January 2026. | 3/3 | pass | pass |
| tpl_customer_net_sales_top3_jan_2026_83a22a | Which three customers spent the most with us, net of tax, i… | 3/3 | pass | pass |
| tpl_customer_gross_top3_apr_2026_70fe90 | Top 3 customers by gross amount in April 2026. | 3/3 | pass | pass |
| tpl_customer_gross_top3_apr_2026_110586 | Which three customers had the highest gross sales, tax incl… | 3/3 | pass | pass |
| tpl_total_gross_q1_2026_3c6ada | What was the total gross amount for Q1 2026? | 3/3 | pass | pass |
| tpl_total_gross_q1_2026_a60515 | Gross sales including tax for the first quarter of 2026. | 3/3 | pass | pass |
| tpl_store_gross_feb_2026_a9f48b | Gross amount by store location for February 2026. | 3/3 | pass | pass |
| tpl_store_gross_feb_2026_dcaf7e | How much gross turnover (incl. tax) did each store record i… | 3/3 | pass | pass |
| tpl_gross_monthly_2025_a7ccf5 | Monthly gross amount in 2025. | 3/3 | pass | pass |
| tpl_gross_monthly_2025_5c3840 | Show 2025 gross sales by month. | 3/3 | pass | pass |
| tpl_doctype_gross_dec_2025_0c318c | Gross amount by document type in December 2025. | 3/3 | pass | pass |
| tpl_doctype_gross_dec_2025_ec84b1 | For December 2025, what was the gross value of each type of… | 3/3 | pass | pass |
| tpl_product_net_sales_top5_feb_2026_55ebcb | Top 5 products by net sales in February 2026. | 3/3 | pass | pass |
| tpl_product_net_sales_top5_feb_2026_8f83c2 | Which five items earned the most revenue in February 2026? | 3/3 | pass | pass |
| tpl_product_net_sales_top5_q1_2026_e4aae1 | Best five products by net revenue across Q1 2026. | 3/3 | pass | pass |
| tpl_product_net_sales_top5_q1_2026_d39faf | What were our top 5 products by net sales in the first quar… | 3/3 | pass | pass |
| tpl_product_net_sales_rank_dec_2025_af0d37 | Rank products by turnover for December 2025. | 3/3 | pass | pass |
| tpl_product_net_sales_rank_dec_2025_6f2136 | Order every product we sold in December 2025 by its net tak… | 3/3 | pass | pass |
| tpl_brand_net_sales_feb_2026_bce7ab | Net sales by brand for February 2026. | 3/3 | pass | pass |
| tpl_brand_net_sales_feb_2026_196b6b | How much revenue did each brand bring in during February 20… | 3/3 | pass | pass |
| tpl_brand_net_sales_top3_q1_2026_025f70 | Top 3 brands by turnover in Q1 2026. | 3/3 | pass | pass |
| tpl_brand_net_sales_top3_q1_2026_d343eb | Which three brands brought in the most money, net of tax, f… | 3/3 | pass | pass |
| tpl_sunvale_net_sales_monthly_q1_2026_002849 | Monthly net sales of Sunvale Foods products in Q1 2026. | 0/3 | wrong_result | model |
| tpl_sunvale_net_sales_monthly_q1_2026_334c95 | How did Sunvale Foods revenue develop month by month in the… | 0/3 | wrong_result | model |
| tpl_category_net_sales_apr_2026_864bce | Turnover by category in April 2026. | 3/3 | pass | pass |
| tpl_category_net_sales_apr_2026_ce5e82 | Net takings per category for April 2026. | 3/3 | pass | pass |
| tpl_category_net_sales_top2_nov_2025_42ea08 | Which two categories had the highest net sales in November … | 3/3 | pass | pass |
| tpl_category_net_sales_top2_nov_2025_6b30e4 | Top 2 departments by net revenue, November 2025. | 3/3 | pass | pass |
| tpl_category_net_sales_q1_2025_4b171c | Turnover by category in Q1 2025. | 3/3 | pass | pass |
| tpl_category_net_sales_q1_2025_de597f | Break down first-quarter 2025 net takings by category. | 3/3 | pass | pass |
| tpl_campaign_net_sales_q1_2026_918652 | Turnover by campaign for Q1 2026. | 3/3 | pass | pass |
| tpl_campaign_net_sales_q1_2026_0be558 | How much did each promotion take in, net of tax, in January… | 3/3 | pass | pass |
| tpl_weekend_pantry_net_sales_monthly_q1_2026_712deb | Monthly net sales for the Weekend Pantry campaign in Q1 202… | 3/3 | pass | pass |
| tpl_weekend_pantry_net_sales_monthly_q1_2026_2e6c4d | Show Weekend Pantry promotion revenue for each month of the… | 3/3 | pass | pass |
| tpl_product_net_sales_top5_online_fulfillment_mar_2026_1493f4 | Top 5 products by net sales at the Online Fulfillment locat… | 3/3 | pass | pass |
| tpl_product_net_sales_top5_online_fulfillment_mar_2026_288feb | Which five products earned the most revenue through Online … | 3/3 | pass | pass |
| tpl_brand_net_sales_lakeside_q1_2026_f69a42 | Net sales by brand for Lakeside Wholesale in Q1 2026. | 3/3 | pass | pass |
| tpl_brand_net_sales_lakeside_q1_2026_96ca32 | Which brands did Lakeside Wholesale buy in the first quarte… | 3/3 | pass | pass |
| tpl_category_net_sales_by_store_mar_2026_42ede5 | Net sales by product category and store location in March 2… | 3/3 | pass | pass |
| tpl_category_net_sales_by_store_mar_2026_9fb06f | For March 2026, show revenue for each category and store co… | 3/3 | pass | pass |
| tpl_household_net_sales_feb_2026_43d02f | What were net sales of Household products in February 2026? | 3/3 | pass | pass |
| tpl_household_net_sales_feb_2026_79c349 | How much Household category revenue did we make in February… | 3/3 | pass | pass |
| tpl_herbal_tea_net_sales_monthly_nov_2025_feb_2026_a36878 | Monthly turnover of Herbal Tea Variety Pack from November 2… | 3/3 | pass | pass |
| tpl_herbal_tea_net_sales_monthly_nov_2025_feb_2026_af98b0 | How much did the Herbal Tea Variety Pack take, net of tax, … | 3/3 | pass | pass |
| tpl_product_qty_top5_feb_2026_be59ea | Top 5 products by quantity sold in February 2026. | 3/3 | pass | pass |
| tpl_product_qty_top5_feb_2026_8a9dc1 | Which five SKUs moved the most units in February 2026? | 3/3 | pass | pass |
| tpl_product_qty_top3_apr_2026_7a55d8 | Top 3 items by units in April 2026. | 3/3 | pass | pass |
| tpl_product_qty_top3_apr_2026_676f6f | Which three products sold the highest number of units in Ap… | 3/3 | pass | pass |
| tpl_product_qty_top3_jan_2026_e4d59c | Which three products sold the most units in January 2026? | 3/3 | pass | pass |
| tpl_product_qty_top3_jan_2026_d8b0a4 | Top 3 products by quantity sold, January 2026. | 3/3 | pass | pass |
| tpl_brand_qty_q1_2026_8f2e8c | Units sold by brand in Q1 2026. | 3/3 | pass | pass |
| tpl_brand_qty_q1_2026_d9b68b | How many units of each brand did we sell between January an… | 3/3 | pass | pass |
| tpl_category_qty_feb_2026_7d67a2 | Quantity sold per product category in February 2026. | 3/3 | pass | pass |
| tpl_category_qty_feb_2026_937554 | How many units did each category sell in February 2026? | 3/3 | pass | pass |
| tpl_campaign_qty_mar_2026_3bb5cf | Units sold per campaign in March 2026. | 3/3 | pass | pass |
| tpl_campaign_qty_mar_2026_b58de1 | How many units did each promotion move in March 2026? | 3/3 | pass | pass |
| tpl_kitchen_towels_qty_q1_2026_db17e4 | How many units of Kitchen Towels 4 Roll did we sell in Q1 2… | 3/3 | pass | pass |
| tpl_kitchen_towels_qty_q1_2026_9d5e9a | Total quantity of Kitchen Towels 4 Roll sold in the first q… | 3/3 | pass | pass |
| tpl_cane_sugar_qty_monthly_q1_2026_382678 | Monthly quantity of Cane Sugar 2kg sold in Q1 2026. | 3/3 | pass | pass |
| tpl_cane_sugar_qty_monthly_q1_2026_f87077 | How many units of Cane Sugar 2kg did we sell in each month … | 3/3 | pass | pass |
| tpl_store_qty_mar_2026_4d7e63 | Units per store location in March 2026. | 3/3 | pass | pass |
| tpl_store_qty_mar_2026_651565 | How many units left each of our locations in March 2026? | 3/3 | pass | pass |
| tpl_customer_qty_top3_q1_2026_2f8130 | Which three customers bought the most units in Q1 2026? | 3/3 | pass | pass |
| tpl_customer_qty_top3_q1_2026_1d11c5 | Top 3 customers by quantity purchased, January–March 2026. | 3/3 | pass | pass |
| tpl_total_qty_dec_2025_12ab97 | How many units did we sell in total in December 2025? | 3/3 | pass | pass |
| tpl_total_qty_dec_2025_214320 | Total quantity sold across all products in December 2025. | 3/3 | pass | pass |
| tpl_store_document_count_q1_2026_de8eff | Number of documents per store location in Q1 2026. | 3/3 | pass | pass |
| tpl_store_document_count_q1_2026_89c42b | How many documents came from each store in January–March 20… | 3/3 | pass | pass |
| tpl_document_count_may_2026_7afacb | How many documents did we have in May 2026? | 3/3 | pass | pass |
| tpl_document_count_may_2026_0fecfa | Number of documents dated May 2026. | 3/3 | pass | pass |
| tpl_document_count_monthly_2026_bd4fed | Number of documents by month for 2026. | 3/3 | pass | pass |
| tpl_document_count_monthly_2026_891aba | How many documents did we record in each month of 2026? | 3/3 | pass | pass |
| tpl_doctype_document_count_q1_2026_09b038 | How many documents of each document type were there in Q1 2… | 3/3 | pass | pass |
| tpl_doctype_document_count_q1_2026_8b9849 | Count first-quarter 2026 documents by type of document. | 3/3 | pass | pass |
| tpl_store_receipt_count_2026_f470c5 | How many store receipts were there in 2026? | 3/3 | pass | pass |
| tpl_store_receipt_count_2026_1d19d1 | Number of Store Receipt documents dated in 2026. | 3/3 | pass | pass |
| tpl_north_district_document_count_q1_2026_2f136d | How many documents did North District Market have in Q1 202… | 3/3 | pass | pass |
| tpl_north_district_document_count_q1_2026_c55b7e | Number of sales documents for North District Market between… | 0/3 | wrong_result | model |
| tpl_document_count_mar01_10_2026_785050 | How many sales documents were dated between 1 and 10 March … | 3/3 | pass | pass |
| tpl_document_count_mar01_10_2026_8379ac | Count the documents from March 1 to March 10, 2026 (both da… | 3/3 | pass | pass |
| tpl_documents_posted_feb_2026_b4d3f2 | How many documents have a posting date in February 2026? | 3/3 | pass | pass |
| tpl_documents_posted_feb_2026_f54d6b | Count the documents whose posting date falls in February 20… | 3/3 | pass | pass |
| tpl_documents_due_apr_2026_6be86c | How many documents fall due in April 2026? | 3/3 | pass | pass |
| tpl_documents_due_apr_2026_0cbf15 | Number of documents with a due date in April 2026. | 3/3 | pass | pass |
| tpl_distinct_customers_feb_2026_20cd13 | How many different customers bought from us in February 202… | 3/3 | pass | pass |
| tpl_distinct_customers_feb_2026_44d3b9 | Number of unique buying customers in February 2026. | 3/3 | pass | pass |
| tpl_store_distinct_customers_q1_2026_b74372 | How many distinct customers did each store serve in Q1 2026? | 3/3 | pass | pass |
| tpl_store_distinct_customers_q1_2026_ac8de6 | Unique customers per store location, January to March 2026. | 3/3 | pass | pass |
| tpl_distinct_customers_monthly_q1_2026_c34a0c | Unique customers per month in Q1 2026. | 3/3 | pass | pass |
| tpl_distinct_customers_monthly_q1_2026_18c53a | How many different customers bought in each month of the fi… | 3/3 | pass | pass |
| tpl_category_distinct_customers_mar_2026_483c88 | How many different customers bought each category in March … | 3/3 | pass | pass |
| tpl_category_distinct_customers_mar_2026_cd96b8 | For March 2026, count the distinct buyers of every category. | 3/3 | pass | pass |
| tpl_urban_refresh_customers_q1_2026_809e2f | How many customers bought Urban Refresh campaign products i… | 3/3 | pass | pass |
| tpl_urban_refresh_customers_q1_2026_93e881 | Number of distinct customers who purchased anything from th… | 3/3 | pass | pass |
| tpl_distinct_customers_2025_262e73 | How many distinct customers did we sell to in 2025? | 3/3 | pass | pass |
| tpl_distinct_customers_2025_e215f0 | Count the unique customers with at least one purchase in ca… | 3/3 | pass | pass |
| tpl_average_order_value_mar_2026_30dc49 | What was the average order value in March 2026? | 3/3 | pass | pass |
| tpl_average_order_value_mar_2026_f43d5d | Average net value per sales document in March 2026. | 3/3 | pass | pass |
| tpl_store_average_order_value_q1_2026_146d60 | Average order value by store location in Q1 2026. | 3/3 | pass | pass |
| tpl_store_average_order_value_q1_2026_6d6a04 | What was the average net amount per document at each store … | 3/3 | pass | pass |
| tpl_average_order_value_monthly_q1_2026_afb751 | Average order value per month in Q1 2026. | 3/3 | pass | pass |
| tpl_average_order_value_monthly_q1_2026_a4c81a | How did the average net ticket size change month by month i… | 3/3 | pass | pass |
| tpl_doctype_average_order_value_feb_2026_b77961 | Average net amount per document by document type in Februar… | 3/3 | pass | pass |
| tpl_doctype_average_order_value_feb_2026_ef742a | For each type of document, what was the average net value i… | 3/3 | pass | pass |
| tpl_customer_average_order_value_top3_q1_2026_820a8d | Which three customers had the highest average order value i… | 3/3 | pass | pass |
| tpl_customer_average_order_value_top3_q1_2026_277c0e | Top 3 customers by average net value per document, January–… | 3/3 | pass | pass |
| tpl_outstanding_balance_mar_2026_45fa9f | What is the total outstanding balance on documents dated Ma… | 3/3 | pass | pass |
| tpl_outstanding_balance_mar_2026_c15bb6 | How much is still unpaid on March 2026 sales? | 3/3 | pass | pass |
| tpl_store_outstanding_balance_q1_2026_2e50d7 | Outstanding balance by store location for Q1 2026 documents. | 3/3 | pass | pass |
| tpl_store_outstanding_balance_q1_2026_a1b239 | For documents dated January to March 2026, how much remains… | 3/3 | pass | pass |
| tpl_outstanding_balance_due_apr_2026_1644d3 | How much unpaid balance falls due in April 2026? | 3/3 | pass | pass |
| tpl_outstanding_balance_due_apr_2026_571390 | Total open amount on documents with a due date in April 202… | 3/3 | pass | pass |
| tpl_doctype_outstanding_balance_feb_2026_0a4e2a | Open balance by document type for February 2026. | 1/3 | wrong_result | model |
| tpl_doctype_outstanding_balance_feb_2026_60324a | How much is still owed on February 2026 documents, split by… | 3/3 | pass | pass |
| tpl_outstanding_balance_monthly_q1_2026_59ffde | Outstanding balance by document month for Q1 2026. | 3/3 | pass | pass |
| tpl_outstanding_balance_monthly_q1_2026_9b1029 | For each month of Q1 2026, how much of that month’s sales i… | 3/3 | pass | pass |
| tpl_paid_amount_mar_2026_c60586 | How much has been paid on documents dated March 2026? | 3/3 | pass | pass |
| tpl_paid_amount_mar_2026_3b957c | Total payments received against March 2026 sales. | 3/3 | pass | pass |
| tpl_account_debit_credit_q1_2026_96b9de | Debit and credit totals by account name for sales dated in … | 3/3 | pass | pass |
| tpl_account_debit_credit_q1_2026_a36558 | For sales dated January to March 2026, list each account by… | 3/3 | pass | pass |
| tpl_account_debit_credit_posted_apr_2026_2218ff | List each account by name with its debits and credits for p… | 3/3 | pass | pass |
| tpl_account_debit_credit_posted_apr_2026_b2a856 | Using the posting date, what were the total debits and cred… | 3/3 | pass | pass |
| tpl_account_net_movement_feb_2026_b8ae99 | Net movement (debits minus credits) per ledger account name… | 3/3 | pass | pass |
| tpl_account_net_movement_feb_2026_c1256b | For each account, by name, what is debit minus credit on po… | 3/3 | pass | pass |
| tpl_revenue_credits_monthly_q1_2026_e1b20a | Monthly credits posted to account 4000 (Sales Revenue) in Q… | 3/3 | pass | pass |
| tpl_revenue_credits_monthly_q1_2026_4e91fe | How much was credited to ledger 4000 in each month of the f… | 3/3 | pass | pass |
| tpl_receivable_debits_posted_mar_2026_aab20c | Total debits posted to account 1100 in March 2026. | 3/3 | pass | pass |
| tpl_receivable_debits_posted_mar_2026_e02d53 | What was debited to ledger account 1100 by postings dated M… | 3/3 | pass | pass |
| tpl_manual_journal_debits_2026_f1b9a6 | How much was debited in manual journal postings (not linked… | 3/3 | pass | pass |
| tpl_manual_journal_debits_2026_6b202b | Total debits of 2026 postings that have no sales document a… | 3/3 | pass | pass |
| tpl_account_posting_count_mar_2026_9b1a49 | How many postings hit each ledger account in March 2026 (by… | 3/3 | pass | pass |
| tpl_account_posting_count_mar_2026_20e22f | Count the journal lines per account name posted in March 20… | 3/3 | pass | pass |
| tpl_active_customers_without_sales_q1_2026_d84881 | Which active customers had no sales in Q1 2026? | 3/3 | pass | pass |
| tpl_active_customers_without_sales_q1_2026_a927e0 | List active customers who did not buy anything between Janu… | 3/3 | pass | pass |
| tpl_customers_bought_feb_not_mar_2026_a6915c | How many customers bought in February 2026 but not in March… | 3/3 | pass | pass |
| tpl_customers_bought_feb_not_mar_2026_bbddd4 | Count the customers with a February 2026 purchase and none … | 3/3 | pass | pass |
| tpl_last_purchase_date_by_customer_280fb1 | What was the most recent purchase date for each customer? | 3/3 | pass | pass |
| tpl_last_purchase_date_by_customer_1aa9cb | When did each customer last buy from us? | 3/3 | pass | pass |
| tpl_largest_document_mar_2026_9fc4f8 | Which sales document had the highest net amount in March 20… | 3/3 | pass | pass |
| tpl_largest_document_mar_2026_3e654b | What was our single biggest document by net value in March … | 3/3 | pass | pass |
| tpl_canceled_document_count_q1_2026_3180c4 | How many sales documents were canceled in Q1 2026? | 3/3 | pass | pass |
| tpl_canceled_document_count_q1_2026_cbb487 | Count the canceled documents dated January to March 2026. | 3/3 | pass | pass |
| tpl_store_canceled_value_q1_2026_ae683a | Number and net value of canceled documents by store locatio… | 3/3 | pass | pass |
| tpl_store_canceled_value_q1_2026_570e8b | For each store, how many documents were canceled between Ja… | 3/3 | pass | pass |

149 holdout case(s) not listed: holdout results are shown in aggregate only (by split); pass --reveal-holdout to list them.

## By split, failure class, difficulty and tag

Failure class, difficulty and tag rows cover the dev cases only, and the holdout row shows its accuracy only (the holdout is shown in aggregate, by split).

| Group | Value | Cases | Accuracy | Majority passes |
| --- | --- | --- | --- | --- |
| split | dev | 245 | 95.2% | 233/245 |
| split | holdout | 147 | 84.4% | not shown |
| failure_class | (none) | 45 | 100.0% | 45/45 |
| failure_class | aggregation_shape | 35 | 91.4% | 32/35 |
| failure_class | ambiguous_metric | 2 | 100.0% | 2/2 |
| failure_class | campaign_join_path | 3 | 100.0% | 3/3 |
| failure_class | default_filter | 16 | 75.0% | 12/16 |
| failure_class | distinct_count | 10 | 100.0% | 10/10 |
| failure_class | empty_result | 4 | 100.0% | 4/4 |
| failure_class | entity_filter | 16 | 81.3% | 13/16 |
| failure_class | entity_resolution | 4 | 75.0% | 3/4 |
| failure_class | grain_confusion | 18 | 100.0% | 18/18 |
| failure_class | metric_column_confusion | 20 | 96.7% | 19/20 |
| failure_class | multilingual | 5 | 100.0% | 5/5 |
| failure_class | ratio_metric | 8 | 100.0% | 8/8 |
| failure_class | relative_date | 5 | 100.0% | 5/5 |
| failure_class | stale_snapshot_field | 5 | 100.0% | 5/5 |
| failure_class | time_window | 20 | 100.0% | 20/20 |
| failure_class | typo | 4 | 100.0% | 4/4 |
| failure_class | vocabulary | 5 | 100.0% | 5/5 |
| failure_class | wrong_date_column | 11 | 100.0% | 11/11 |
| failure_class | wrong_join_path | 9 | 100.0% | 9/9 |
| difficulty | easy | 16 | 100.0% | 16/16 |
| difficulty | hard | 134 | 97.0% | 130/134 |
| difficulty | medium | 95 | 91.9% | 87/95 |
| tag | accounting | 21 | 81.0% | 17/21 |
| tag | aggregation | 67 | 99.0% | 66/67 |
| tag | aggregation_shape | 1 | 100.0% | 1/1 |
| tag | all_time | 4 | 100.0% | 4/4 |
| tag | ambiguous | 2 | 100.0% | 2/2 |
| tag | anti_join | 8 | 100.0% | 8/8 |
| tag | average_order_value | 10 | 100.0% | 10/10 |
| tag | bilingual | 1 | 100.0% | 1/1 |
| tag | brand | 12 | 91.7% | 11/12 |
| tag | campaign | 6 | 100.0% | 6/6 |
| tag | canceled | 4 | 100.0% | 4/4 |
| tag | comparison | 4 | 100.0% | 4/4 |
| tag | count | 7 | 100.0% | 7/7 |
| tag | credit | 9 | 77.8% | 7/9 |
| tag | customer | 43 | 100.0% | 43/43 |
| tag | date | 2 | 100.0% | 2/2 |
| tag | date_range | 14 | 100.0% | 14/14 |
| tag | debit | 10 | 80.0% | 8/10 |
| tag | distinct_customers | 13 | 100.0% | 13/13 |
| tag | document_count | 22 | 95.5% | 21/22 |
| tag | document_type | 16 | 95.8% | 15/16 |
| tag | due_date | 4 | 100.0% | 4/4 |
| tag | duplicate_name | 1 | 100.0% | 1/1 |
| tag | filter_brand | 2 | 0.0% | 0/2 |
| tag | filter_campaign | 4 | 100.0% | 4/4 |
| tag | filter_customer | 6 | 50.0% | 3/6 |
| tag | filter_document_type | 6 | 83.3% | 5/6 |
| tag | filter_product | 6 | 100.0% | 6/6 |
| tag | filter_product_category | 2 | 100.0% | 2/2 |
| tag | filter_store_location | 6 | 100.0% | 6/6 |
| tag | formerly_holdout | 77 | 96.1% | 74/77 |
| tag | fuzzy | 2 | 100.0% | 2/2 |
| tag | grain_confusion | 1 | 100.0% | 1/1 |
| tag | gross_amount | 11 | 100.0% | 11/11 |
| tag | hard_case | 30 | 96.7% | 29/30 |
| tag | join_path | 2 | 100.0% | 2/2 |
| tag | line_net_sales | 36 | 94.4% | 34/36 |
| tag | master_data | 1 | 100.0% | 1/1 |
| tag | metric_confusion | 1 | 100.0% | 1/1 |
| tag | named_entity | 5 | 80.0% | 4/5 |
| tag | net_movement | 2 | 100.0% | 2/2 |
| tag | net_sales | 64 | 95.3% | 61/64 |
| tag | new_vocabulary | 5 | 100.0% | 5/5 |
| tag | outstanding_balance | 13 | 94.9% | 12/13 |
| tag | paid_amount | 2 | 100.0% | 2/2 |
| tag | paraphrase | 9 | 77.8% | 7/9 |
| tag | pivot | 4 | 100.0% | 4/4 |
| tag | posting_date | 14 | 100.0% | 14/14 |
| tag | postings | 2 | 100.0% | 2/2 |
| tag | product | 23 | 100.0% | 23/23 |
| tag | product_category | 17 | 100.0% | 17/17 |
| tag | quantity | 30 | 96.7% | 29/30 |
| tag | quarter | 68 | 92.7% | 63/68 |
| tag | ranking | 57 | 93.0% | 53/57 |
| tag | relative_date | 5 | 100.0% | 5/5 |
| tag | retrieval | 2 | 100.0% | 2/2 |
| tag | sales_document | 10 | 100.0% | 10/10 |
| tag | scalar | 64 | 93.8% | 60/64 |
| tag | single_month | 89 | 99.3% | 88/89 |
| tag | stale_snapshot | 1 | 100.0% | 1/1 |
| tag | store_location | 21 | 100.0% | 21/21 |
| tag | swedish | 4 | 100.0% | 4/4 |
| tag | templated | 189 | 96.5% | 182/189 |
| tag | temporal | 18 | 77.8% | 14/18 |
| tag | time_series | 26 | 88.5% | 23/26 |
| tag | typo | 4 | 100.0% | 4/4 |
| tag | year | 14 | 92.9% | 13/14 |
| tag | zero_row | 4 | 100.0% | 4/4 |

## Cost, latency, retries, tokens

Cost, latency, retries and tokens cover the dev cases only (the holdout is shown in aggregate, by split; the Budget row, when there is one, is the whole run's spend). `--reveal-holdout` covers every case.

| Metric | Value |
| --- | --- |
| Total LLM cost | $0.2325 |
| Cost per question | $0.00030 |
| Cost per correct answer | $0.00033 |
| Question latency p50 / p95 (product loop, wall) | 2.52 s / 4.57 s (n=765) |
| Per question incl. gold and scoring p50 / p95 | 2.53 s / 4.58 s (n=765) |
| LLM call latency p50 / p95 | 2.50 s / 4.49 s (n=773) |
| Retry rate | 1.1% of questions (8/765); 8 of 773 LLM calls were retries |
| Tokens | prompt 3,457,490 (cached 3,249,920) · completion 271,515 (reasoning 73,942) |
| Budget | $0.4493 of $1.00 |

## Verification

Fixtures: seed current (checked), v2 current (checked), v3 current (checked).

Gold and controls: 404 case(s) verified on every fixture, 0 with problems; gates passed.

| Dataset | Design kill rate | Held-out kill rate | Killed on seed alone | Undecided | Invalid | Unscored | Positive controls |
| --- | --- | --- | --- | --- | --- | --- | --- |
| core-public | 77/77 (100.0%) | 16/16 (100.0%) | 31/77 | 0 | 0 | 0 | 41/41 match, 40 accepted |
| edge-cases-public | 152/152 (100.0%) | 28/28 (100.0%) | 57/152 | 0 | 0 | 0 | 73/73 match, 72 accepted |
| hard-cases-public | 140/140 (100.0%) | 15/19 (79.0%) | 48/140 | 0 | 0 | 0 | 34/34 match, 34 accepted |
| holdout-public | 779/779 (100.0%) | 64/74 (86.5%) | 249/779 | 0 | 0 | 0 | 23/23 match, 23 accepted |
| paraphrase-public | 77/77 (100.0%) | 16/16 (100.0%) | 31/77 | 0 | 0 | 0 | 41/41 match, 40 accepted |
| templated-public | 1504/1504 (100.0%) | 185/236 (78.4%) | 340/1504 | 0 | 0 | 0 | 59/59 match, 59 accepted |

## Provenance

|  |  |
| --- | --- |
| Git | 717ec520a363 (dirty working tree) |
| Prompt version | 4358263bcf82 |
| Schema scope | auto -> full (2,258 of 8,000 estimated tokens for the full schema; 13 in-scope tables) |
| Hints version | 2 (default) |
| Semantic layer version | 14fcdaffcffa (with overlay metadata/semantic-layer.hints-v2.json 18c3a9517d9e) |
| Schema version | e841a06bba01 |
| Fixtures | seed 094282546fe5, v2 7adec1b3bc33, v3 51d1c42c3b88 |
| Datasets | core-public 63732ca9d4d3, edge-cases-public 3f3c375d680e, hard-cases-public 18e96270f43e, holdout-public 46eb1f1e31bc, paraphrase-public c28dabfa0da7, templated-public 154a8192371e |
| Controls | datasets/controls/core-public.json ac2f2d4d66c5, datasets/controls/edge-cases-public.json b62ffdf172e3, datasets/controls/hard-cases-public.json fa64f0aa5466, datasets/controls/holdout-public.json b2ca4abfbbe6, datasets/controls/templated-public.json d8aa80b079e8 |
| Model / endpoint | deepseek/deepseek-v4.1-flash @ openrouter.ai |
| Model settings | model from --model; reasoning effort low (--reasoning-effort); request options: max_tokens 16000, reasoning {"enabled":true,"effort":"low"}, provider {"require_parameters":true} |
| Node | v24.21.0 (linux-x64) |
| Runner | suite all; repeat 3; concurrency 4; case timeout 120.00 s; budget $1.00; retries 1; statement timeout 8.00 s |

## Legacy pooled reliability

Dev cases only (the holdout is shown in aggregate, by split): pooled pass rate 95.2% over 735 repetition(s), pooled Wilson 95% lower bound 93.5%. Kept for older consumers only: repetitions of one case are correlated, so the pooled bound overstates confidence. Use the case-level numbers above.
