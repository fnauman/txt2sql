---
marp: true
title: Text-to-SQL that you can actually trust on real data
description: An introduction to a guardrailed, retrieval-first text-to-SQL pipeline for MariaDB
paginate: true
theme: default
class: lead
style: |
  section {
    font-size: 26px;
    background: #0f1117;
    color: #e6e6e6;
  }
  h1 { color: #8ab4ff; }
  h2 { color: #8ab4ff; }
  strong { color: #ffd479; }
  code { color: #9cdcfe; background: #1b1f2a; }
  a { color: #8ab4ff; }
  table { font-size: 20px; }
  blockquote { border-left: 4px solid #8ab4ff; color: #b9c0cc; }
  section.lead h1 { font-size: 46px; }
---

<!-- _class: lead -->

# Text-to-SQL you can trust on real data

### A retrieval-first, guardrailed pipeline for MariaDB

A small, testable, **deterministic** layer wrapped around an LLM —
built for wide, business-critical ERP schemas, not toy demos.

<!--
Speaker notes: This deck introduces the project and contrasts it with the
"paste the schema, run whatever the model returns" approach most text-to-SQL
demos take.
-->

---

## The problem with most text-to-SQL demos

A typical demo is three lines:

1. Paste the **whole schema** into the prompt
2. Ask the model for SQL
3. **Run whatever it returns**

This looks great on a 5-table SQLite toy.

It falls apart the moment the database is **real**:

- Hundreds of tables → the prompt is huge, slow, and confusing
- The model invents columns, joins, and entity IDs that don't exist
- "Read-only" is an assumption, not a guarantee
- "It worked once" is mistaken for "it's reliable"

---

## What this project is

A **minimal but production-minded** text-to-SQL starter:

- Targets **MariaDB 10.6**, OpenAI-compatible models
- Prompt context is compiled from **Sequelize model files** (`models/`)
- Ships a **13-table synthetic retail demo** (`demo_retail`) — no real data
- A CLI **and** a small React web workspace (`apps/web/`)

> The guiding idea: **the LLM proposes, a deterministic layer disposes.**
> Retrieval is *enforced*, not advisory. Safety is *checked*, not assumed.

---

## The pipeline at a glance

```
question
   │
   ▼
temporal normalization      "March 2026" → [2026-03-01, 2026-04-01)
   │
   ▼
semantic retrieval          pick only the in-scope tables (not all of them)
   │
   ▼
master-data resolution      resolve "sparkling water" → bounded candidate rows
   │
   ▼
LLM (structured JSON out)    { sql, explanation, tables_used, assumptions }
   │
   ▼
deterministic guardrails     re-validate SQL vs the exact schema it saw
   │
   ▼
read-only execution          single SELECT/WITH, table allow-list
   │
   ▼
value-aware result scoring
```

---

## How it differs — 1 of 2

| Typical demo | This repo |
|---|---|
| Whole schema in every prompt | **Semantic retrieval** selects only the tables a question needs |
| Model output trusted & executed | **Deterministic guardrails** re-validate every table, column, and join |
| "Read-only" assumed | **Read-only enforced** by keyword/function denylist + single-statement check |
| Entity names guessed | **Bounded master-data resolution** before generation |

---

## How it differs — 2 of 2

| Typical demo | This repo |
|---|---|
| Dates left to the model | **Temporal normalization** → explicit half-open ranges |
| "Right answer once" | **Reliability measurement**: `--repeat N`, Wilson 95% lower bound |
| Cost ignored | **Cache-aware prompt layout** + per-call token/cost accounting |
| Schema can silently drift | Schema **auto-recompiles** when the model cache drifts |

---

## Safety is checked, not assumed

The model's SQL is re-validated locally **before** it ever runs:

- First keyword must be `SELECT` / `WITH`; **single statement only**
- Denylist blocks DML/DDL, `INTO OUTFILE`, locking reads, `@`/`@@`,
  `information_schema`/`mysql`/`sys`, and timing/exfiltration functions
- Every table/column must exist in the **retrieved** schema context
- Joins must match **in-scope foreign keys** or declared join hints
- Filter IDs must come from the **resolved candidate list**
- **Cross-database references are rejected** — `FROM otherdb.Table` fails the allow-list

No extra LLM calls — it's plain, testable JavaScript.

---

## Defense in depth, all the way to the database

Guardrails are the first line — **not the only one**.

- Run the demo against its **own database** (`demo_retail`)
- Connect as a **least-privilege `SELECT`-only user**, never `root`:

```sql
CREATE USER 'demo_readonly'@'%' IDENTIFIED BY '<strong-password>';
GRANT SELECT ON demo_retail.* TO 'demo_readonly'@'%';
```

Result: even a mistyped `DB_NAME` or a script that bypasses the pipeline
**physically cannot** read other databases or write anything.

---

## Measuring reliability, not luck

Generation is non-deterministic — one passing run is a **sample**, not proof.

- A **value-aware comparator** scores answers on *values*, not column names
  (a correct answer with a different alias is no longer a false failure)
- `--repeat N` reports **min / mean / max** accuracy across runs
- The honest headline is the **Wilson 95% lower bound**, not "100%"

> 6/6 on one run has a true-pass-rate lower bound near **0.6**, not 1.0.

A public **edge-case suite** targets the hard parts: metric/grain confusion,
join-path traps, temporal parsing, fuzzy matching, empty-result robustness.

---

## Cost and prompt-cache awareness

- Every LLM call estimates **token cost**, printed per-call and per-run
- The optimized prompt is laid out **cache-first**: stable instructions and
  selected schema go *before* volatile, question-specific context
- An **offline estimator** reports the cacheable-prefix size before you spend
  a cent — repeated questions reuse a long cached prefix instead of resending
  the full product master

---

## Try it in two minutes

```bash
npm install
cp .env.example .env          # set OPENAI_API_KEY + DB creds
docker compose up -d mariadb  # MariaDB 10.6, bound to 127.0.0.1
npm run bootstrap-db          # create the 13-table schema
npm run seed-demo             # load the synthetic retail data
npm run optimized -- "Show outstanding balance by customer"
```

Inspect without spending an LLM call:

```bash
npm run debug-retrieval -- "Which SKUs moved the most in March 2026?"
npm run benchmark -- --dataset edge-cases-public --repeat 10
```

---

<!-- _class: lead -->

## Takeaway

Text-to-SQL is easy to **demo** and hard to **trust**.

This project keeps the LLM where it's strong — turning language into a query —
and surrounds it with a small, deterministic, **testable** layer that handles
retrieval, safety, entity resolution, dates, and honest reliability numbers.

**The model proposes. The guardrails dispose.**

See `README.md` for the full walkthrough.
