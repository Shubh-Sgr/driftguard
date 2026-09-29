# DriftGuard

**An MCP server + CLI that lets AI assistants safely inspect, plan and _prove_ PostgreSQL migrations.**
The LLM proposes; deterministic code decides.

[![CI](https://github.com/Shubh-Sgr/driftguard/actions/workflows/ci.yml/badge.svg)](https://github.com/Shubh-Sgr/driftguard/actions/workflows/ci.yml)

## The problem

Writing `ALTER TABLE` is the easy part of a database migration. The hard parts are:

1. **What differs?** Schemas drift between environments (hotfixes, failed migrations, manual changes).
2. **What will it lock?** `CREATE INDEX` on a busy table blocks every write until it finishes. A "1 ms" `ALTER TABLE` can still cause an outage by waiting in the lock queue.
3. **Is the data really the same?** "Row counts match" is not proof.
4. **Which rows are wrong?** When proof fails, you need the exact rows, not "something in this 2M-row table".

AI assistants now write migrations, but they hallucinate objects, ignore locks and can't prove anything.
DriftGuard gives them (and you) read-only tools that answer those four questions, and it wraps every AI suggestion in deterministic checks.

## Results (measured, not estimated)

All numbers come from `npm run eval` against the seeded Docker databases. The full tables are in [evals/](evals/).

| What | Result |
|---|---|
| Drift detection over 21 seeded scenarios | **100% precision, 100% recall** (23 true positives, 0 false positives, 0 missed) |
| Exact differing rows found by checksum bisection | **100%** of seeded row changes, **0** false rows |
| Rows fetched to find them | **311 rows** instead of **6,079,997** (the rows in the mismatched tables, both sides) |
| Lock mode predicted vs lock actually taken (read from `pg_locks`) | **30/30** statements |
| Table rewrite predicted vs actual rewrite (`pg_class.relfilenode` changed) | **29/29** statements |
| Rules-only migration plans that pass a shadow run on a real schema copy | **17/17** |
| LLM plans (local llama3.2, 3B), 17 drift scenarios | **5.9%** valid on first try, **17.6%** after one retry, **82.4%** fell back to the rules plan; **0/3** accepted LLM plans passed the shadow run |

**Application stall during the migration**, measured on the 1M-row table with a probe query every ~10 ms ([evals/results-rewrite.md](evals/results-rewrite.md)):

| Migration | Original: max stall | DriftGuard rewrite: max stall | Rewrite total time |
|---|---|---|---|
| `CREATE INDEX` | 901 ms | 37 ms | 0.91 s (same) |
| `ADD FOREIGN KEY` (2M rows) | 612 ms | 8 ms | 0.40 s |
| `ADD CHECK` | 255 ms | 8 ms | 0.28 s |
| `SET NOT NULL` | 438 ms | 25 ms | 0.45 s |
| `ADD COLUMN ... NOT NULL DEFAULT gen_random_uuid()` | 6.68 s | 583 ms | 46.3 s (batched backfill) |
| `ALTER COLUMN merchant_id TYPE bigint` | 8.90 s | 174 ms | 32.7 s (+4 manual steps) |

**What the LLM numbers show:** a small local model is not reliable at migration planning. That's why DriftGuard never trusts it. The validator rejected 14/17 plans (unparseable SQL, hallucinated or duplicate objects, blocking DDL). The 3 it accepted were *safe but incomplete*, and only the shadow run caught that (e.g. a missing index and a sequence left out when re-creating a dropped table). Deterministic rules plans passed 17/17. Details: [evals/results-llm.md](evals/results-llm.md).

The trade-off is visible: the rewrites that need a backfill take much longer in total, but the application keeps running.
These are single runs on a laptop (Apple M1, 8 cores, Docker Desktop). Expect the absolute numbers to vary; the gap is the point.

## How it works

```mermaid
flowchart LR
  A["AI assistant<br/>(Claude Code, Cursor)"] -- "MCP (JSON-RPC, stdio)" --> S
  U["You (terminal)"] -- CLI --> S
  subgraph S["DriftGuard core"]
    I["F1 introspect<br/>pg_catalog"] --> D["F2 diff<br/>(pure function)"]
    D --> P["F7 planner<br/>LLM + guardrail validator"]
    L["F5 lock analyzer<br/>(Postgres parser)"] --> R["F6 safe rewrites"]
    R --> P
    P --> SH["F10 shadow run<br/>(throwaway container)"]
    V["F3 chunked checksums"] --> B["F4 bisection"]
    P --> RC["F12 receipt<br/>(SHA-256)"]
  end
  S -- "read-only SQL" --> SRC[("source DB")]
  S -- "read-only SQL" --> TGT[("target DB")]
  P -. "structured facts only, no rows" .-> LLM["Ollama (local)<br/>or Gemini"]
```

**Golden rule:** the LLM never touches a database and never decides pass/fail. It proposes; the parser, the rules and the shadow run decide.

| # | Feature | How |
|---|---|---|
| F1 | Schema introspection | `pg_catalog` (not `information_schema`, which hides index methods, partial-index predicates and `NOT VALID`) |
| F2 | Drift detection | A pure `diffSchemas(source, target)`: deterministic and sorted, with severity rules, and it never guesses renames |
| F3 | Data verification | `md5(string_agg(md5(row::text) ORDER BY pk))` per primary-key chunk, inside a `REPEATABLE READ` snapshot with normalized session settings |
| F4 | Checksum bisection | Merkle-style: split the mismatched chunk at its median key and recurse only into halves whose hashes differ |
| F5 | Lock analyzer | [libpg-query](https://github.com/launchql/libpg-query-node) (Postgres' own parser, WASM) → rule table → risk from `reltuples` |
| F6 | Safe rewrites | `CONCURRENTLY`, `NOT VALID` + `VALIDATE`, `UNIQUE ... USING INDEX`, expand/contract, batched `DO` loops with `COMMIT` per batch |
| F7 | Guarded LLM planner | zod-checked JSON → validator (parses, allow-list, objects exist, no unsafe DDL) → one retry → rules-only fallback |
| F8 | MCP server | 6 read-only tools over stdio |
| F9 | Eval suite | 21 drift/data scenarios, 30 lock statements with ground truth from Postgres, and a stall benchmark under load |
| F10 | Shadow runs | Copies the target's *schema* into a disposable container, applies the plan, and diffs the result against the source |
| F11 | Reversibility | Tags each step `reversible` / `reversible-with-backfill` / `data-lossy` and generates rollback SQL |
| F12 | Receipts | JSON of drift + verification + plan + shadow, with a SHA-256 over canonical (sorted-key) JSON |

## Quickstart (local, zero cost)

Requirements: Node 20+ and Docker.

```bash
git clone https://github.com/Shubh-Sgr/driftguard.git && cd driftguard
npm install
cp .env.example .env
npm run db:up          # two Postgres 16 containers, seeded: ~3 min on first start
npm run cli -- doctor  # confirms both connections are read-only
```

| Container | Port | Contents |
|---|---|---|
| `source-db` | 5433 | Fintech schema, 10 tables: 1M `transactions`, 2M `ledger_entries`, composite-PK and no-PK tables |
| `target-db` | 5434 | Identical copy. Eval scenarios create drift in scratch copies of it. |

### CLI

```bash
npm run cli -- diff                                   # schema drift (exit code 1 if any)
npm run cli -- verify --rows                          # checksums + exact differing rows
npm run cli -- locks examples/risky-migration.sql     # lock impact per statement
npm run cli -- rewrite examples/risky-migration.sql   # safe multi-step script
npm run cli -- plan --no-llm                          # rules-only plan
npm run cli -- plan                                   # LLM plan (Ollama) behind guardrails
npm run cli -- shadow                                 # plan, then prove it on a throwaway container
npm run cli -- receipt --shadow                       # hashed audit record
npm run cli -- receipt-verify driftguard-receipt.json
```

`locks --fail-on high` exits with code 1, so it can gate a CI pipeline on risky migrations.

### Try some drift

```bash
docker exec -i driftguard-target-db-1 psql -U postgres -d fintech -c "DROP INDEX transactions_account_created_idx; UPDATE transactions SET amount = amount + 1 WHERE id = 424242;"
npm run cli -- diff
npm run cli -- verify --table transactions --rows
```

`npm run db:down && npm run db:up` resets everything.

## MCP setup

Build once with `npm run build`, then register the server.

**Claude Code**, either from the CLI:

```bash
claude mcp add driftguard -e SOURCE_DATABASE_URL=postgres://driftguard_ro:driftguard_ro_local@localhost:5433/fintech -e TARGET_DATABASE_URL=postgres://driftguard_ro:driftguard_ro_local@localhost:5434/fintech -- node /absolute/path/to/driftguard/dist/cli/index.js mcp
```

or by committing a `.mcp.json` in your project. **Cursor** uses `.cursor/mcp.json`. Both use the same shape; see [examples/mcp.json](examples/mcp.json).

Then ask: *"Use driftguard to check whether target has drifted from source, and plan a safe fix."*

| Tool | What it returns |
|---|---|
| `detect_drift` | Every schema difference, with severity |
| `verify_data` | Per-table checksum status and mismatched key ranges |
| `find_differing_rows` | Exact rows (keys and changed column names; values only with `includeValues: true`) |
| `analyze_locks` | Lock, blocking, scan/rewrite and risk for each statement of the SQL you pass |
| `suggest_safe_rewrite` | A safe script starting with `SET lock_timeout` / `statement_timeout` |
| `plan_migration` | A validated plan as SQL text for a human to review |

All tools are annotated `readOnlyHint: true`. None of them can write to a database.

Docker instead of Node: `docker run -i --rm -e SOURCE_DATABASE_URL=... -e TARGET_DATABASE_URL=... ghcr.io/shubh-sgr/driftguard` (defaults to `mcp`).

## Safety model

- **Read-only, three layers:** the `driftguard_ro` role has only `SELECT`, the role defaults to `default_transaction_read_only`, and every connection sets `default_transaction_read_only=on`, `statement_timeout` and `lock_timeout` in its startup packet. That holds even if you hand it a superuser URL; there's an integration test for exactly that.
- **Never loads a table into memory:** hashes are computed inside Postgres, and only 32-character digests cross the network. Bisection fetches at most 50 rows per side per leaf.
- **Parameterized queries** for every value. Identifiers come only from the catalog, and they are quoted.
- **Connection strings** come only from the environment, never from tool input.
- **No row data is sent to the LLM.** The prompt contains the drift report and table shapes only. That blocks prompt injection through database contents, and your data never leaves the machine with Ollama.
- **Shadow runs** write only to a container DriftGuard creates on `127.0.0.1` with a random password, and removes afterwards.

## Design decisions

- **Rules, not the LLM, for safety-critical transformations.** A rewrite that is right "most of the time" is not good enough for production data. The LLM's job is ordering and explaining, and it is optional.
- **Ground truth from Postgres.** The lock eval reads real locks from `pg_locks` and real rewrites from `relfilenode`, instead of comparing against a table I wrote myself.
- **Hash of hashes.** Using `md5` per row, then `md5` of their concatenation, bounds the aggregate at 32 bytes per row, whatever the table width.
- **Chunk boundaries from real keys** (`row_number() % chunk_size`), so sparse, UUID and composite keys all chunk evenly. The first and last chunks are unbounded, so rows that exist only on the target are still caught.
- **Pure diff function.** It is trivial to unit-test and is reused by the CLI, the MCP server, the planner, the shadow run and the evals.
- **One service layer** ([src/service.ts](src/service.ts)) behind both the CLI and MCP, so they can't disagree.
- **The shadow eval found a real bug:** the type-change rewrite dropped the column's `DEFAULT`/`NOT NULL`. It is fixed, with a regression test (commit `cc4f55b`).

## Limitations (honest list)

- PostgreSQL only; tested on 16.
- Renames are reported as drop + add, with an advisory `possible_rename` hint. DriftGuard never auto-renames.
- Tables without a primary key: a mismatch is detected, but the rows can't be localized.
- Verification compares two snapshots. On a live system, run it during a write freeze or once replication has caught up.
- The lock analyzer knows about 30 statement shapes. Anything else is flagged "not in the rule table", never silently rated safe.
- Automatic batched backfills need a single integer primary key; otherwise the backfill step becomes a manual template.
- Shadow runs copy the **schema only**, so they prove the resulting structure, not timing under production load (the lock analyzer covers that).
- Expand/contract for type changes still needs human steps: deploying dual-writes and re-creating indexes/FKs on the new column.
- The eval scenarios were written by me. They cover known cases, including tricky ones (volatile defaults, composite keys, partial indexes, session-setting traps), and they're all public in [evals/scenarios](evals/scenarios).
- The Gemini adapter is implemented but was not exercised in the evals (no API key used).

## Roadmap

- MySQL support.
- Replication-aware verification: compare both sides at a known LSN.
- A GitHub Action that comments lock analysis on migration pull requests.
- Automatic re-creation of indexes/FKs in the type-change rewrite.
- Make a passing shadow run part of accepting an LLM plan (today the validator proves a plan safe, not complete).
- Signed receipts (Ed25519) in addition to the SHA-256 integrity hash.
- Hosted demo on free tiers (Neon branches for shadow runs).

## Development

```bash
npm test                  # 112 unit tests, no database needed
npm run test:integration  # needs `npm run db:up`
npm run eval              # all evals → evals/results*.md
npm run eval -- --only scenarios --llm llama3.2   # include LLM plans (needs Ollama)
```

```
src/
  introspect/  F1   diff/     F2   verify/   F3 + F4   locks/  F5   rewrite/  F6
  plan/        F7   llm/      Ollama + Gemini           mcp/    F8   shadow/   F10
  reversibility/ F11  receipt/ F12   cli/   service.ts (shared by CLI + MCP)
evals/         F9   scenarios/, locks/, lib/, results*.md
docker/        docker-compose.yml + deterministic seed + read-only role
```

MIT licensed.
