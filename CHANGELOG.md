# Changelog

All notable changes to PgVouch. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (0.x: minor versions may change behavior).

## [Unreleased]

### Changed
- **Renamed from DriftGuard to PgVouch** (the npm name `driftguard` belongs to an unrelated project). Breaking for existing setups: the CLI is now `pgvouch`, environment variables are `PGVOUCH_*` (was `DRIFTGUARD_*`), the demo read-only role is `pgvouch_ro`, the MCP server name is `pgvouch`, and the Docker image is `ghcr.io/<owner>/pgvouch`. Recreate the demo databases with `npm run db:down && npm run db:up`.

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

[Unreleased]: https://github.com/Shubh-Sgr/pgvouch/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Shubh-Sgr/pgvouch/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Shubh-Sgr/pgvouch/releases/tag/v0.1.0
