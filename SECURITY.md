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

- **Least privilege is the real boundary.** Everything that runs
  model-generated SQL (web app, `basic`, `optimized`, benchmark,
  `resolve-master-data`) connects as the query user (`DB_USER`, default
  `demo_readonly`). Docker Compose creates it on first volume init
  (`docker/mariadb/initdb/01-readonly-user.sh`) with `SELECT` on
  `` `demo\_retail%`.* `` only: no `FILE` privilege (so no `LOAD_FILE` or
  `INTO OUTFILE`), no writes or DDL, no other databases. Admin credentials
  (`DB_ADMIN_*` / `MARIADB_ROOT_PASSWORD`) are used only by `bootstrap-db` and
  `seed-demo`. The web server at startup, the `basic`/`optimized` CLIs and the
  token-authorized deep health check warn when the query user has more than
  `SELECT`/`USAGE`, or grants that reach system schemas or other databases.
  See the README "Demo data and safety" section for non-Compose setups.
- **Read-only validation is defense in depth.** Generated SQL is read through
  one MariaDB-faithful tokenizer (`src/sql-tokenizer.js`) and must be a single
  `SELECT`/`WITH` statement with no comments, no `WITH RECURSIVE`, no
  cross-database or metadata-schema references, and no denylisted keywords or
  functions (DML/DDL, any `INTO`, `SET`, locking reads, `@`/`@@` variables,
  timing, locking, file and session-information functions, also when
  backtick-quoted). Every table must be in the allowed set. See
  `validateSqlSafety` / `validateReadOnlySql` in `src/pipeline.js`, with
  `validateSqlGuardrails` in `src/sql-guardrails.js` as a schema-aware second
  layer on the optimized path (qualified columns, joins, metrics, fan-out,
  product candidate IDs). Every rejection carries `error.code` and
  `error.layer`.
- **Execution is bounded.** Generated SQL runs under a MariaDB statement
  timeout on every path (`QUERY_STATEMENT_TIMEOUT_MS`, default 8000 ms). The web
  path also caps rows server-side (`sql_select_limit`, with the read stopped at
  the cap) and sends `KILL QUERY` when a request is cancelled or exceeds its
  deadline. The OpenAI client has a per-attempt timeout and a retry cap.
- **HTTP surface.** The API binds to `127.0.0.1` by default. On a loopback bind,
  requests with a `Host` header other than a loopback name or a
  `WEB_ALLOWED_HOSTS` entry get 403 (DNS-rebinding protection); API requests
  from an `Origin` outside `WEB_ALLOWED_ORIGINS` get 403. Responses carry
  `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and
  `Cross-Origin-Resource-Policy: same-origin`. `WEB_API_TOKEN` (optional bearer
  auth, never shipped to the browser) also gates the deep health check and is
  required for `POST /api/admin/refresh-schema`. Debug payloads (prompts, raw
  model output, stack traces) are returned only when `WEB_ALLOW_DEBUG` allows
  them, by default only on a loopback bind; otherwise infra error messages are
  redacted for callers without the token.
- **Browser features are default-deny.** Client-side data features are gated to
  the synthetic demo database only; the browser never sends SQL.

## Known gaps

These are accepted today and bounded only by the database grants and the
execution limits above:

- Resource-heavy read-only SQL passes validation, for example a `REPEAT()`
  memory bomb or a cartesian self-join. The statement timeout (and, on the web
  path, the row cap) bounds it.
- The function check is a denylist; there is no function allowlist yet.
- The master-data candidate check covers product ID literals only and can be
  bypassed (for example with a subquery or a join on the product name).
- Unqualified column checks are partial; unknown lower-case names are left to
  MariaDB.

## Scope

The threat model is a single-user local/demo deployment. Multi-tenant or
internet-exposed use would need per-user authentication, per-identity cache keys, and a
hardened deployment that are intentionally out of scope here.
