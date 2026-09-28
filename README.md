# DriftGuard

An MCP server + CLI that lets AI assistants safely inspect, plan, and *prove* PostgreSQL migrations.
**The LLM proposes; deterministic code decides.**

> Work in progress. See [docs/DriftGuard_Plan.md](docs/DriftGuard_Plan.md) for the feature list and roadmap.

## Quickstart (local, zero cost)

Requirements: Node 20+, Docker.

```bash
npm install
cp .env.example .env
npm run db:up          # two Postgres 16 containers, seeded (~3 min on first start)
npm run cli -- doctor  # confirms both connections are read-only
```

| Container | Port | Contents |
|---|---|---|
| `source-db` | 5433 | Fintech schema, 10 tables, 1M `transactions`, 2M `ledger_entries` |
| `target-db` | 5434 | Identical copy; eval scenarios introduce drift here |

`npm run db:down` removes both containers and their data.

## Safety model

DriftGuard never writes to a database. Three independent layers enforce this:

1. **Role:** it connects as `driftguard_ro`, which only has `SELECT` ([docker/seed/00_roles.sql](docker/seed/00_roles.sql)).
2. **Session:** every connection sets `default_transaction_read_only=on`, `statement_timeout`, and `lock_timeout` ([src/db.ts](src/db.ts)), even if given a superuser URL.
3. **Config:** connection strings come only from the local environment, never from tool input.

## Tests

```bash
npm test                  # unit tests (no database needed)
npm run test:integration  # needs `npm run db:up`
```
