# DriftGuard

**An MCP server + CLI that lets AI assistants safely inspect, plan and _prove_ PostgreSQL migrations.**
The LLM proposes; deterministic code decides.

[![CI](https://github.com/Shubh-Sgr/driftguard/actions/workflows/ci.yml/badge.svg)](https://github.com/Shubh-Sgr/driftguard/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

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

### Running on an 8 GB laptop

DriftGuard was built and measured on an 8 GB MacBook Air (M1). It stays responsive if you:

- Give Docker Desktop **3 GB** of memory (Settings → Resources). The two databases are capped at 768 MB each in `docker-compose.yml`, and shadow containers at 256 MB.
- Run one heavy thing at a time: `db:up`, integration tests, and evals each create or scan millions of rows.
- Use `DRIFTGUARD_LLM=none` unless you need the LLM planner. When it's used, Ollama unloads the model 30 s after the last request.
- Skip `npm run eval -- --llm ...` (~1 hour on a 3B model) unless you want those numbers; the default eval doesn't call an LLM.
- Want an even lighter setup? Seed fewer rows: `npm run db:down && SEED_TRANSACTIONS=100000 npm run db:up` (seconds instead of ~3 min). CI uses 20,000. The published eval numbers and `npm run eval` need the default 1,000,000.

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

## Step-by-step: test every feature

This walkthrough uses the two demo databases from the Quickstart. You break the target on purpose, then watch each feature find and fix it.
Run the commands one at a time from the `driftguard` folder. **Want it automatic?** `npm run demo` runs steps 1–9 with pauses and repairs the target at the end.

> macOS: if a command fails with `Operation not permitted` / `EPERM uv_cwd`, give your terminal access to the folder: System Settings → Privacy & Security → Files and Folders → (your terminal) → Documents.

**1. Baseline: everything matches**

```bash
npm run cli -- diff      # "No schema drift: source and target match."
npm run cli -- verify    # "IDENTICAL": 10 tables, ~3.1M rows compared by hash
```

**2. Break the target** (this plays "someone made a mistake"; DriftGuard itself can't write)

```bash
docker exec driftguard-target-db-1 psql -U postgres -d fintech -c "DROP INDEX transactions_account_created_idx"
docker exec driftguard-target-db-1 psql -U postgres -d fintech -c "ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_transaction_id_fkey"
docker exec driftguard-target-db-1 psql -U postgres -d fintech -c "ALTER TABLE customers ADD COLUMN legacy_code int"
docker exec driftguard-target-db-1 psql -U postgres -d fintech -c "UPDATE transactions SET amount = amount + 1 WHERE id = 424242"
docker exec driftguard-target-db-1 psql -U postgres -d fintech -c "DELETE FROM ledger_entries WHERE id IN (777001, 777002)"
```

**3. Schema drift (F1 + F2)**

```bash
npm run cli -- diff
```
Expect 3 items: the missing index (low), the missing foreign key (high), the extra `legacy_code` column (medium). Exit code 1.

**4. Exact differing rows (F3 + F4)**

```bash
npm run cli -- verify --table transactions ledger_entries --rows
```
Expect `changed id=424242 columns: amount`, `missing_in_target id=777001` and `id=777002`, and a `bisection:` line showing ~150 rows fetched out of 3M.

**5. Lock impact of a migration (F5)**

```bash
npm run cli -- locks examples/risky-migration.sql
npm run cli -- locks examples/risky-migration.sql --fail-on high; echo "exit code: $?"   # 1 = a CI pipeline would stop here
```
Each statement shows its lock (e.g. `SHARE ... blocks writes`), whether it scans or rewrites the table, and a risk level, plus a warning that `lock_timeout` is missing.

**6. Safe rewrite of the same migration (F6)**

```bash
npm run cli -- rewrite examples/risky-migration.sql
```
Expect `SET lock_timeout` first. `CREATE INDEX` becomes `CONCURRENTLY`, the FK gets `NOT VALID` then `VALIDATE`, and the new NOT NULL column gets a batched backfill loop.

**7. Plan the fix (F7 + F11)**

```bash
npm run cli -- plan --no-llm   # rules-only: each step has risk, reversibility and rollback SQL
npm run cli -- plan            # optional, ~2 min: the LLM plans (needs Ollama); watch the guardrail reject bad plans
```
The data-lossy `DROP COLUMN legacy_code` step is commented out unless you pass `--allow-data-loss`.

**8. Prove the plan on a throwaway copy (F10)**

```bash
npm run cli -- shadow --no-llm
```
Expect `Shadow run: PASS`, every step `applied`, and `the shadow matches the source schema`.

**9. Tamper-evident receipt (F12)**

```bash
npm run cli -- receipt --no-llm --out receipt.json
npm run cli -- receipt-verify receipt.json   # "OK: receipt intact"
```
Edit any value in `receipt.json` and run `receipt-verify` again: it reports `MODIFIED`.

**10. From an AI assistant (F8):** follow [Use it from an AI assistant (MCP)](#use-it-from-an-ai-assistant-mcp) below, then ask *"Use driftguard to find schema drift and the differing rows in ledger_entries."*

**11. Reset**

```bash
npm run db:down && npm run db:up   # fresh, identical databases again (~3 min)
```

**Automated tests:** `npm test` (unit, no database) and `npm run test:integration` (needs the databases).

## Use it from an AI assistant (MCP)

[MCP](https://modelcontextprotocol.io) (Model Context Protocol) is the standard way AI assistants call external tools. DriftGuard runs as a local MCP server: the assistant (Claude Code, Cursor, …) starts it as a child process and talks to it over stdin/stdout. You then ask questions in plain English, and the assistant decides which DriftGuard tools to call.

### Step 1: build it and make sure the databases are up

```bash
npm install && npm run build   # creates dist/cli/index.js, the file the assistant will run
npm run db:up                  # or use your own databases (see "Use it on your own databases")
npm run cli -- doctor          # both connections must say read_only=true
```

### Step 2: register the server

Pick **one** option. Replace `/absolute/path/to/driftguard` with the real folder path (run `pwd` inside it).

**Claude Code (terminal or desktop app).** One command, run in any terminal where the `claude` CLI is installed:

```bash
claude mcp add driftguard \
  -e SOURCE_DATABASE_URL=postgres://driftguard_ro:driftguard_ro_local@localhost:5433/fintech \
  -e TARGET_DATABASE_URL=postgres://driftguard_ro:driftguard_ro_local@localhost:5434/fintech \
  -e DRIFTGUARD_LLM=none \
  -- node /absolute/path/to/driftguard/dist/cli/index.js mcp
```

Add `--scope project` to store it in the project's `.mcp.json` (shared with your team through git) instead of only for you.

**Or a config file.** Works for Claude Code (`.mcp.json` in your project root) and **Cursor** (`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for all projects). Copy [examples/mcp.json](examples/mcp.json) there and fix the path.

**Or Docker, no Node needed.** Use [examples/mcp-docker.json](examples/mcp-docker.json). Inside a container `localhost` is the container itself, so the URLs use `host.docker.internal` to reach databases on your machine. The GHCR image is private until the repo owner makes the package public; until then, build it locally (`docker build -t driftguard .`) and use `driftguard` as the image name.

`DRIFTGUARD_LLM=none` means `plan_migration` returns the deterministic rules-only plan. Set `ollama` to let a local model propose plans (they still go through the validator).

### Step 3: check it's connected

- **Claude Code:** run `claude mcp list` (it should show `driftguard ... ✓ Connected`), or type `/mcp` inside a session. Start a **new** session after adding a server.
- **Cursor:** Settings → MCP. `driftguard` should show a green dot and 6 tools. Restart Cursor after editing the file.

### Step 4: ask

| Ask the assistant | Tool it calls |
|---|---|
| "Has the target database drifted from source? Group the differences by severity." | `detect_drift` |
| "Is the data in source and target identical?" | `verify_data` |
| "Which exact rows differ in `ledger_entries`?" | `find_differing_rows` (keys and changed columns only) |
| "Show me the actual values of those rows." | `find_differing_rows` with `includeValues: true` |
| "What will `ALTER TABLE transactions ALTER COLUMN merchant_id TYPE bigint` lock, and for how long?" | `analyze_locks` |
| "Rewrite this migration so it doesn't block production: …" | `suggest_safe_rewrite` |
| "Plan a safe migration that makes target match source." | `plan_migration` |

A typical agentic flow: *"Check target for drift, explain the risky items, and give me a safe migration plan"*. The assistant calls `detect_drift`, then `plan_migration`, and may run `analyze_locks` on the result.

**Safety:** all 6 tools are read-only (annotated `readOnlyHint: true`). None of them can write to a database; plans come back as SQL for you to review and run yourself. Connection strings come from the config above, never from the conversation. Row values are only returned when explicitly asked for.

### Troubleshooting

| Symptom | Fix |
|---|---|
| Server shows "failed" / not connected | Start it yourself with the same settings: `SOURCE_DATABASE_URL=... TARGET_DATABASE_URL=... node /absolute/path/to/driftguard/dist/cli/index.js mcp`. It should print `driftguard MCP server ... ready on stdio` (then Ctrl-C). A config error names the missing variable. (The server doesn't read `.env`; the variables must come from the MCP config.) |
| `Cannot find module .../dist/cli/index.js` | Run `npm run build`, and check the path is absolute. |
| Tools fail with `ECONNREFUSED` / `Connection terminated` | The databases aren't running or are still seeding. Run `npm run db:up` and wait for `Healthy`. |
| Docker variant can't reach the databases | Use `host.docker.internal` instead of `localhost` in the URLs. |
| `EPERM` / "Operation not permitted" on macOS | Give the app that launches the server (your terminal / Cursor) access to the folder: System Settings → Privacy & Security → Files and Folders. |

Remove it again with `claude mcp remove driftguard`, or by deleting the entry from the JSON file.

## Use it on your own databases

The demo data is only for trying it out. To use DriftGuard for real:

**1. Choose the pair of databases.** Which features make sense depends on the pair:

| Situation | Source → Target | Use |
|---|---|---|
| Staging vs production (the data is supposed to differ) | staging → prod | `diff`, `plan`, `shadow` (schema only) |
| Moving a database (cloud move, version upgrade, blue/green) | old → new | `diff` **and** `verify --rows` (the data should be identical) |
| Replica / CDC pipeline check | primary → replica | `verify --rows` |
| Reviewing a migration before it runs | (the database it will run on) | `locks`, `rewrite` |

**2. Create a read-only role** on each database (as an admin):

```sql
CREATE ROLE driftguard_ro LOGIN PASSWORD 'choose-a-strong-password';
ALTER ROLE driftguard_ro SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE your_db TO driftguard_ro;
GRANT USAGE ON SCHEMA public TO driftguard_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO driftguard_ro;
```

**3. Point DriftGuard at them** in `.env` (never commit this file):

```bash
SOURCE_DATABASE_URL=postgres://driftguard_ro:PASSWORD@staging-host:5432/your_db
TARGET_DATABASE_URL=postgres://driftguard_ro:PASSWORD@prod-host:5432/your_db
DRIFTGUARD_LLM=none
```

Then `npm run cli -- doctor` must say `read_only=true` and `write privileges: none` before you run anything else. For huge tables, run `verify` against a read replica.

**4. Gate migrations in CI.** No database is needed with `--offline`:

```bash
npx tsx src/cli/index.ts locks migrations/0042_add_index.sql --offline --fail-on high
```

**5. Or run the Docker image** (no Node install): `docker run -i --rm --env-file .env ghcr.io/shubh-sgr/driftguard diff`. Any CLI command works in place of `diff`; with no command it starts the MCP server. `shadow` needs a Docker daemon, so run it from the CLI instead.

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

## Contributing

DriftGuard is open source and contributions are welcome: bug reports, new lock rules, new eval scenarios and docs. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and ground rules, and [SECURITY.md](SECURITY.md) to report vulnerabilities privately. This project follows a [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © 2026 Shubham Sagar. Free to use, modify and distribute.
