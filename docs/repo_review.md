# Repository Review Notes

This note captures the current state of the anonymized MariaDB text-to-SQL demo.

## Current State

1. **Retrieval is enforced, not advisory.**
   - Optimized generation validates SQL against the retrieved prompt table set.
   - SQL that references a table outside the allowed set is rejected before execution.

2. **Semantic retrieval is wired into runtime behavior.**
   - `metadata/semantic-layer.json` maps public retail phrasing to preferred tables, display columns, metric expressions, filters, clarification rules, and join hints.
   - Retrieval combines lexical scoring with semantic boosts.
   - Debug and evaluation scripts expose semantic matches and table-score breakdowns.

3. **Product terms use bounded master-data lookup.**
   - Product filter hints drive a pre-generation lookup against whitelisted `Product` columns.
   - Editable value aliases cover demo terms such as `sparkling water`, `protein bar`, and `cold brew`.
   - The LLM prompt receives bounded candidate rows rather than the full product master.

4. **Prompt layout is cache-aware.**
   - Stable instructions stay in the system message.
   - Selected schema context appears before volatile question-specific context in the user message.
   - `context.promptCache` records estimated total, cacheable-prefix, dynamic, and legacy-prefix token counts.

5. **Structured output and guardrails are in place.**
   - Optimized calls request a provider-enforced JSON schema with `sql`, `explanation`, `tables_used`, and `assumptions`.
   - Local guardrails validate exact columns, in-scope joins, semantic metric columns, product candidate IDs, `tables_used`, and query-local CTE names.

## Practical Debugging Loop

1. Run retrieval debugging for the failing question.
2. Check semantic matches, temporal normalization, retrieved examples, and expanded tables.
3. If expected tables are missing, fix semantic metadata or retrieval scoring.
4. If expected tables are present but SQL is wrong, inspect guardrail traces and model assumptions.
5. For product-name ambiguity, run the master-data resolver and check returned candidates.
6. Use benchmark traces to separate retrieval misses, validation errors, execution errors, low-signal successes, and result mismatches.

## Remaining Risks

- The local bootstrap creates an empty schema until demo seed data is loaded.
- Master-data resolution currently covers product candidates only. Other entity values need explicit resolver and guardrail support before relying on them.
- Semantic metadata is intentionally curated and small. New business terms should be added with tests or retrieval-evaluation cases.
- Prompt-cache reports are offline estimates. Real savings should be confirmed with provider-returned cached-token metadata from live runs.

## Commands

```bash
npm run debug-retrieval -- --case-id core_public_001
npm run debug-retrieval -- "Show sparkling water product sales by branch"
npm run evaluate-retrieval -- --dataset core-public
npm run evaluate-retrieval -- --dataset paraphrase-public
npm run resolve-master-data -- "sparkling water sales"
npm run measure-prompt-cache -- --dataset paraphrase-public
npm run benchmark -- --dataset core-public --trace
```
