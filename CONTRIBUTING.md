# Contributing to PgVouch

Thanks for your interest! Bug reports, docs fixes, new lock rules and new eval scenarios are all welcome.

## Set up

Requirements: Node 22 (or 20.12+) and Docker.

```bash
git clone https://github.com/Shubh-Sgr/pgvouch.git && cd pgvouch
npm install
cp .env.example .env
npm run db:up        # add SEED_TRANSACTIONS=20000 for a faster, smaller seed
npm run cli -- doctor
```

## Before you open a pull request

```bash
npm run typecheck
npm test                  # unit tests, no database needed
npm run test:integration  # needs `npm run db:up`
```

CI runs the same checks on every pull request.

## Ground rules

- **PgVouch never writes to a user's database.** New features must work through the read-only role. Anything that writes goes to a disposable shadow container (see `src/shadow/`).
- **Safety logic stays deterministic.** Lock rules, safe rewrites and plan validation are plain code with tests. An LLM may propose, but it never decides.
- **Parameterized queries only.** Identifiers come from the catalog and are quoted with `quoteIdent`/`ident` (`src/sql/ident.ts`).
- **Every behavior change gets a test.** Pure logic goes in `tests/unit`; anything that needs Postgres goes in `tests/integration`.
- **User-visible changes get a line in [CHANGELOG.md](CHANGELOG.md)** under "Unreleased".
- **Numbers in docs must be measured.** If you change an eval result in the README, it must come from `npm run eval`.
- Readable over clever: short comments explaining *why* on non-obvious decisions.

## Good first contributions

- Add a statement to the lock rule table (`src/locks/analyze.ts`) with a unit test, and add it to `evals/locks/corpus.json` so the eval measures it against real `pg_locks`.
- Add an eval scenario: a folder in `evals/scenarios/` with `setup.sql` and `expected.json`.
- Improve error messages or docs.

## Commits

Small commits with [Conventional Commit](https://www.conventionalcommits.org/) messages, e.g. `feat(locks): add rule for ALTER TABLE ... SET TABLESPACE`.

By contributing, you agree that your contributions are licensed under the MIT License.
