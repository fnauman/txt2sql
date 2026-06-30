# Security Policy

This project is a portfolio/demo and ships with **synthetic data only**. It is
not a production deployment, but it does generate and execute SQL against a
database, so a few things are worth taking seriously.

## Reporting a vulnerability

If you find a security issue, please report it privately rather than opening a
public issue:

- Email: farrukh.nauman@inertialrange.com
- Or open a GitHub *security advisory* on this repository.

Please include enough detail to reproduce. I aim to acknowledge reports within
a few days.

## Design notes relevant to security

- **Read-only by construction.** Generated SQL is restricted to a single
  `SELECT`/`WITH` statement and validated against a keyword/function denylist
  (no DML/DDL, file I/O, locking, server variables, metadata schemas, or
  timing/exfiltration functions) plus single-statement and table-scope checks
  before execution. See `validateReadOnlySql` / `READ_ONLY_DENYLIST` /
  `executeReadOnlySql` in `src/pipeline.js`, with `validateSqlGuardrails` in
  `src/sql-guardrails.js` as a schema-aware second layer (columns, joins,
  metrics, resolved candidate IDs).
- **Least privilege is the real boundary.** The application guardrails are
  defense in depth, not a substitute for database isolation. Run against a
  dedicated database as a `SELECT`-only user (see the README "Demo data and
  safety" section).
- **Browser features are default-deny.** Client-side data features are gated to
  the synthetic demo database only; the browser never sends SQL.

## Scope

The threat model is a single-user local/demo deployment. Multi-tenant or
internet-exposed use would need authentication, per-identity cache keys, and a
hardened deployment that are intentionally out of scope here.
