# Changelog

All notable changes to PgVouch. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (0.x: minor versions may change behavior).

## [Unreleased]

## [0.3.1] - 2026-09-30

### Added
- **Published on npm.** Install with `npm install -g pgvouch`, or run any command with `npx pgvouch <command>`. MCP clients can start the server with `npx -y pgvouch mcp`, so registering it no longer needs a clone and a build.
- **The installed CLI reads `./.env`**, like `npm run cli` does. Variables already set in the environment take precedence. The MCP server still takes its settings only from the MCP client config.

## [0.3.0] - 2026-09-30

### Changed
- **Renamed from DriftGuard to PgVouch** (the npm name `driftguard` belongs to an unrelated project). Breaking for existing setups: the CLI is now `pgvouch`, environment variables are `PGVOUCH_*` (was `DRIFTGUARD_*`), the demo read-only role is `pgvouch_ro`, the MCP server name is `pgvouch`, and the Docker image is `ghcr.io/<owner>/pgvouch`. Recreate the demo databases with `npm run db:down && npm run db:up`.
- **License changed from MIT to Apache 2.0**, which adds an explicit patent grant from contributors. A `NOTICE` file ships with the npm package and the Docker image.

### Fixed
- **Type-change rewrite kept indexes and constraints on the old column.** After the expand/contract swap, a foreign key, CHECK, UNIQUE constraint or index on the column stayed on `<col>_old`, so the rules plan failed its own shadow run (e.g. `transactions_merchant_id_fkey` ended up on `merchant_id_old`). They are now copied to the new column without blocking (index `CONCURRENTLY`, FK/CHECK `NOT VALID` + `VALIDATE`, UNIQUE via a concurrent index + `USING INDEX`) and take their original names in the swap. A primary key, exclusion constraints and foreign keys from other tables stay a named manual step. Two new eval scenarios cover it (23 in total, 19/19 rules plans pass the shadow run).
- **The column swap is atomic.** The two renames now run inside one `BEGIN ... COMMIT`, so there is no moment where the column name doesn't exist.
- **The plan validator accepted any `DROP`.** `DROP SCHEMA ... CASCADE`, `DROP VIEW`, `DROP FUNCTION` etc. passed and were rendered as normal steps. Only `DROP INDEX` and `DROP TABLE` are allowed now.
- **Typos gave misleading answers.** An unknown schema (`diff --schema typo`) reported "No schema drift"; an unknown table (`verify --table typo`, MCP `find_differing_rows`) reported "DIFFERENCES FOUND". Both are now errors. `--chunk-size` and `--max-rows` reject invalid numbers up front, and `receipt-verify` says clearly when a file isn't a receipt.

## [0.2.0] - 2026-09-29

### Added
- **Lock-queue preflight (F13):** `pgvouch preflight <file>` and the MCP tool `check_lock_queue` answer "is it safe to run this right now?". They compare the lock each statement needs with the target's live `pg_locks` / `pg_stat_activity`, using Postgres' full lock conflict table: sessions holding or already waiting for a conflicting lock, and, for `CREATE INDEX CONCURRENTLY`, every open transaction. Never returns other sessions' query text and never terminates sessions. Works with "limited visibility" without `pg_read_all_stats`.
- **PR review (F14):** `pgvouch review <files...> --format markdown|json|text` (offline) and a GitHub Action (`action.yml`) that writes the lock analysis and safe rewrites of the migrations a pull request changes to the job summary and one PR comment.
- `PGVOUCH_SHADOW_VERIFY=on|off` (default `on`).
- A demo GIF in the README.

### Changed
- **LLM plans must pass a shadow run to be accepted.** Before, the validator alone decided, which proved plans safe but not complete (measured: 0/3 accepted llama3.2 plans passed the shadow run). A shadow failure is sent back to the LLM for its retry; if the shadow can't run (e.g. no Docker), the rules plan is used and the reason is reported. Plans now include `acceptedBy`, `fallbackReason` and a `stage` per attempt.
- **Shadow runs treat plan SQL as untrusted:** it runs as a non-superuser role (`pg_read_file`, `COPY ... PROGRAM` are denied), with a per-statement client-side timeout, and the container is limited to 256 MB, 1 CPU and 256 processes. Ctrl-C removes the container.
- The MCP server now has 7 tools (`check_lock_queue` is new). With an LLM configured, `plan_migration` may start a short-lived local container for the shadow run.
- The demo seed grants `pg_read_all_stats` to `pgvouch_ro` (reset with `npm run db:down && npm run db:up`).
- The demo databases' bind address is configurable (`DB_BIND`, default `127.0.0.1`); CI uses it so shadow runs work on Linux runners.
- Node 22 LTS, updated CI actions, Dependabot for npm and GitHub Actions (minor and patch updates).

### Fixed
- The demo databases listen on `127.0.0.1` only.

### Not re-measured
- The LLM planner numbers in the README are from v0.1.0 (validator-only acceptance). They have not been re-measured with the shadow gate yet.

## [0.1.0] - 2026-09-29

First public release: schema introspection and drift detection, chunked checksum verification with bisection to the exact differing rows, lock-impact analysis, safe rewrites, a guarded LLM planner with a rules-only fallback, shadow runs, reversibility tags, hashed receipts, an MCP server with 6 read-only tools, and an eval suite.

[Unreleased]: https://github.com/Shubh-Sgr/pgvouch/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/Shubh-Sgr/pgvouch/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Shubh-Sgr/pgvouch/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Shubh-Sgr/pgvouch/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Shubh-Sgr/pgvouch/releases/tag/v0.1.0
