# Evaluation Dataset And Scoring

This repository now uses deterministic public demo datasets instead of live private data.

| Asset | Path |
|---|---|
| Core public benchmark | `datasets/core-public.json` |
| Paraphrase public benchmark | `datasets/paraphrase-public.json` |
| Edge-case public benchmark | `datasets/edge-cases-public.json` |
| Value-aware comparator | `compareResults` in `src/benchmark.js` |
| Dataset verifier | `scripts/verify-dataset.js` |
| Demo seed | `scripts/seed-public-db.js` |

The public fixture preserves the important text-to-SQL failure modes: metric-column confusion, header-vs-line grain, join-path selection, stale snapshot columns, named document type filtering, temporal reasoning, anti-joins, fuzzy product terms, and SQL guardrails.

Run locally after bootstrapping and seeding MariaDB:

```bash
npm run verify-dataset -- --dataset core-public
npm run verify-dataset -- --dataset paraphrase-public
npm run verify-dataset -- --dataset edge-cases-public
npm run evaluate-retrieval -- --dataset edge-cases-public
```

The datasets are intentionally synthetic. Do not add generated traces, private database dumps, or customer/vendor-specific examples to this directory.
