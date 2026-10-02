# Contributing to PgVouch

Thanks for your interest! Bug reports, docs fixes, new lock rules and new eval scenarios are all welcome.

## Set up

Requirements: Node 22 (or 20.12+) and Docker.

```bash
git clone https://github.com/Shubh-Sgr/pgvouch.git && cd pgvouch
npm install
cp .env.example .env
npm run db:up        # add SEED_TRANSACTIONS=20000 for a faster, smaller seed; PG_VERSION=13..17 for another Postgres (default 16)
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

## Releasing (maintainers)

1. On a branch: bump `version` in `package.json`, `package-lock.json` and `src/version.ts`, and move the "Unreleased" changelog entries under the new version. Merge it through a pull request.
2. Create a GitHub release on `main` with the tag `vX.Y.Z` (the same version). Mark it as a pre-release to publish under the npm `next` tag.
3. The [Release workflow](.github/workflows/release.yml) checks that the tag matches `package.json`, runs the typecheck, unit tests and build, and publishes to npm with provenance. No npm token is involved: npm trusts this repository's `release.yml` (set once under the package's settings on npmjs.com → Trusted publishing).

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE) (see section 5 of the license), including its patent grant.
