# Contributing

Thanks for taking a look. This is primarily a portfolio/reference project, so
the bar is "clear and correct" rather than "feature-complete."

## Getting started

Requires Node.js 22.18 or newer (`.nvmrc` pins 24) and, for the database,
Docker with Compose v2.

    npm install
    npm test               # no database or API key needed
    cp .env.example .env   # then set OPENAI_API_KEY, DB_PASSWORD (query user)
                           # and MARIADB_ROOT_PASSWORD (admin)
    docker compose up -d --wait mariadb
    npm run bootstrap-db
    npm run seed-demo

To use another env file, pass `--dotenv <path>` (or set `ENV_FILE`), not
`--env-file`: Node.js reserves that flag. See the [README](README.md) for the
full setup and architecture.

## Ground rules

- **Synthetic data only.** Never add real customer, product, or financial data
  to code, datasets, metadata, model comments, or tests. The demo is, and must
  stay, fully fictional.
- **Keep SQL read-only.** Any change near generation or execution must preserve
  the read-only / single-statement / table-scope checks, with tests: add bypass
  payloads to `test/sql-bypass-battery.test.js` and valid SQL that must keep
  passing to `test/sql-valid-unusual.test.js`. Query paths connect as the
  `SELECT`-only query user; only `bootstrap-db` and `seed-demo` use admin
  credentials.
- **Docs must stay true.** If a change affects behavior the README, `docs/` or
  `SECURITY.md` describe, update them in the same PR, and do not quote test
  counts.
- **Tests are the contract.** Run `npm test`, `npm run web:typecheck`,
  `npm run web:build` and `npm run web:test`; add a test for any behavior you
  change. None of them needs a database or API key. The MariaDB integration
  tests in `test/mariadb.integration.test.js` run only when `TEST_MARIADB_PORT`
  (and `TEST_MARIADB_PASSWORD`) are set.
- **Small, focused PRs.** One concern per pull request, with a clear message.

## Questions

Open an issue or reach out via [fnauman.com](https://fnauman.com).
