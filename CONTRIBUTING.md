# Contributing

Thanks for taking a look. This is primarily a portfolio/reference project, so
the bar is "clear and correct" rather than "feature-complete."

## Getting started

    npm install
    cp .env.example .env   # then fill in OPENAI_API_KEY + DB_* values
    docker compose up -d mariadb
    npm run bootstrap-db
    npm run seed-demo
    npm test

See the [README](README.md) for the full setup and architecture.

## Ground rules

- **Synthetic data only.** Never add real customer, product, or financial data
  to code, datasets, metadata, model comments, or tests. The demo is, and must
  stay, fully fictional.
- **Keep SQL read-only.** Any change near generation or execution must preserve
  the read-only / single-statement / table-scope guardrails, with tests.
- **Tests are the contract.** Run `npm test` and `npm run web:test`; add a test
  for any behavior you change. Both suites run without a database or API key.
- **Small, focused PRs.** One concern per pull request, with a clear message.

## Questions

Open an issue or reach out via [fnauman.com](https://fnauman.com).
