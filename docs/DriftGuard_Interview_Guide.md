# DriftGuard — Interview Guide

Every feature explained: **what** it does, **how** it works, **why** it was designed that way, and the questions interviewers are likely to ask — with answers.

Read this alongside your own code. If an answer here doesn't match what you actually built, update this file — never say something in an interview you can't show in the repo.

---

## 0. The 60-second pitch

> "At FinacPlus I migrated 15+ microservices and 100+ tables from AWS to GCP. The hard part wasn't writing migrations — it was knowing what differed between databases, what a migration would lock, and proving the data matched afterwards. AI assistants can now write migrations, but they hallucinate and can't prove anything.
>
> So I built DriftGuard: an MCP server and CLI that gives AI assistants safe, read-only tools to detect schema drift, predict lock impact, rewrite risky DDL into non-blocking steps, and verify data with chunked checksums — including a bisection algorithm that finds the exact differing rows. The key design principle: **the LLM proposes, deterministic code decides.** I measured it with an eval suite of [N] seeded scenarios: [your real numbers]."

---

## 1. Schema introspection (F1)

**What:** Reads the full structure of a PostgreSQL database — tables, columns, types, defaults, nullability, primary keys, indexes, constraints, sequences — into a typed TypeScript object.

**How:** Queries the system catalogs:
- `pg_class` (tables, their size estimate `reltuples`)
- `pg_attribute` + `format_type()` (columns and exact types like `numeric(12,2)`)
- `pg_index` + `pg_get_indexdef()` (index definitions, including partial/unique)
- `pg_constraint` + `pg_get_constraintdef()` (PK, FK, CHECK, UNIQUE)
- Filters out system schemas (`pg_catalog`, `information_schema`) and dropped columns (`attisdropped`).

**Why `pg_catalog` instead of `information_schema`?**
`information_schema` is SQL-standard and portable, but it hides PostgreSQL-specific details: index methods (btree/gin), partial index predicates, `NOT VALID` constraints, exact type modifiers. For a Postgres-only safety tool, precision beats portability.

**Likely questions**
- *How do you avoid false drift from formatting differences?* — I normalize: use `pg_get_*def()` functions that return canonical definitions, compare names exactly as the catalog stores them (Postgres already lower-cases unquoted names), and sort every drift item by a stable key so catalog order doesn't matter.
- *What about multiple schemas?* — Every object is keyed as `schema.name`; `--schema` (CLI) or `schemas` (MCP) chooses which schemas to compare (default `public`).

---

## 2. Drift detection (F2)

**What:** `diffSchemas(source, target) → DriftReport` listing missing, extra, and changed objects with severity.

**How:** It's a **pure function** — no DB access — which compares two schema objects map-by-map. Each difference becomes a typed item, e.g. `{ kind: "column_type_changed", table: "transactions", column: "amount", from: "numeric(10,2)", to: "numeric(12,2)" }`.

**Why pure?** Pure functions are trivial to unit-test (no database needed), deterministic, and reusable by the CLI, the MCP server, and the eval suite.

**Likely questions**
- *Can it detect renames?* — Not reliably; a rename looks like "drop + add". I flag pairs with identical types as *possible renames* but never assume — a wrong rename guess could cause data loss. (Honest limitation.)
- *How is severity decided?* — Rules: missing table/column = high; type change = high if narrowing (e.g. `bigint→int`), medium if widening; index difference = low (performance only).

**As built (`src/diff/`):**
- Severities in code: missing table/column/constraint = high. Extra table = medium. Extra column = medium, or **high** if it's NOT NULL with no default (the app's INSERTs would fail). Type change = medium if widening per an explicit allow-list (`smallint→int→bigint`, `varchar(n)→varchar(m≥n)/text`, `numeric(p,s)→numeric(p2≥p,s)`), otherwise high: unknown counts as risky. Nullability: target stricter = high, looser = medium. Default = medium. Missing index = low, or medium if unique. Constraint that differs only by `NOT VALID` = medium.
- Indexes that back a constraint (same name: PK/UNIQUE/EXCLUDE) are reported once, as the constraint. Found while building the planner: otherwise one drop showed up as two items.
- `possible_rename` is emitted only for exactly one missing + one extra column of the same type in a table. It's advisory and not scored in the eval.

---

## 3. Chunked checksum verification (F3)

**What:** Proves that table data is identical on two databases without copying the data.

**How:**
1. Split the table into chunks by primary-key range (e.g. 10,000 rows each).
2. On **both** databases, per chunk run:
   ```sql
   SELECT md5(string_agg(t::text, '|' ORDER BY id))
   FROM transactions t
   WHERE id >= $1 AND id < $2;
   ```
3. Compare hashes. Equal → chunk identical. Different → mismatch.

Only a 32-character hash per chunk crosses the network, not the rows.

**Why chunks?** A single whole-table hash tells you *that* something differs, not *where*. Chunks localize the problem and keep each query short (short queries = no long-running transactions holding back vacuum).

**Important details (interviewers love these)**
- **Deterministic ordering:** `ORDER BY` primary key inside `string_agg`, otherwise row order is arbitrary and hashes differ even for identical data.
- **Normalize session settings** on both connections: `SET TimeZone='UTC'`, `SET DateStyle='ISO'`, `SET extra_float_digits=3` — otherwise `t::text` formats timestamps/floats differently.
- **Consistent snapshot:** run each side in a `REPEATABLE READ` read-only transaction so all chunks see one point-in-time view.
- **Uneven key distribution:** chunk boundaries come from actual keys (e.g. `ntile()` or sampling), not arithmetic ranges, so sparse IDs don't create empty or giant chunks.
- **Composite primary keys:** use row comparison `WHERE (a, b) >= ($1, $2)`.

**Likely questions**
- *Isn't MD5 broken?* — Broken for **security** (deliberate collisions). Here we detect **accidental** differences; accidental MD5 collisions are astronomically unlikely. If needed, swap to SHA-256 via `pgcrypto`'s `digest()`.
- *What if data is being written during verification?* — Two snapshots taken at different moments can legitimately differ. Run verification during a write freeze/cutover window, or after replication catches up; DriftGuard does not yet re-check hot chunks automatically (roadmap), which is why the README says to verify during a freeze.
- *Tables without a primary key?* — No stable ordering exists, so I fall back to a whole-table aggregate hash and report "cannot localize" — a documented limitation.
- *Doesn't hashing scan the whole table anyway?* — Yes, the DB scans it once; the win is **network and memory**: we transfer hashes, not millions of rows.

**As built (`src/verify/`) — the real SQL differs slightly from the sketch above:**
```sql
SELECT count(*), md5(string_agg(md5(ROW(c1, c2, ...)::text), '' ORDER BY pk))
FROM t WHERE pk >= $1 AND pk < $2;
```
- **Hash of hashes:** `md5` per row, then `md5` of the concatenation. The aggregate grows by 32 bytes per row (≈320 KB per 10k-row chunk) no matter how wide the row is.
- **`ROW(cols in SOURCE order)`** instead of `t::text`, so a different column order on the target doesn't cause false mismatches.
- **Chunk boundaries:** every `chunkSize`-th key from `row_number() OVER (ORDER BY pk)` on the source. The first and last chunks are unbounded, so rows that exist only on the target (below the min or above the max key) still land in a chunk.
- **Keys travel as text** (`pk::text`) and go back as parameters that Postgres casts, so no precision is lost in JS (bigint > 2^53, microsecond timestamps).
- Session normalization also sets `IntervalStyle` and `bytea_output`, all with `SET LOCAL` inside the `REPEATABLE READ READ ONLY` transaction.
- **No primary key:** multiset hash, `md5(string_agg(h ORDER BY h))` over per-row hashes. It's deterministic without a key, but can't localize.
- Tables whose columns or PK differ are **skipped with a reason** rather than guessed at: fix schema drift first.
- Measured: all 10 tables (3.14M rows) verified in ~21 s on an M1 laptop. An eval scenario that changes the target's `TimeZone`, `DateStyle` and `extra_float_digits` produced **0 false mismatches**.

---

## 4. Checksum bisection (F4) ⭐

**What:** When a chunk mismatches, finds the **exact differing rows**.

**How:** Binary search:
1. Chunk `[0, 10000)` mismatches.
2. Hash `[0, 5000)` and `[5000, 10000)` on both sides; recurse only into halves that differ.
3. Stop when a range has ≤ 50 rows; fetch those rows from both sides and diff them column by column.

**Complexity:** For one bad row in a chunk of N rows → about `log2(N/50)` rounds of hash queries. For 10,000 rows ≈ 8 rounds, then 50 rows fetched — instead of fetching all 10,000 from both sides.

**Why it's interesting:** It's the same idea as Merkle trees used in Git, Cassandra anti-entropy repair, and blockchains — compare hashes of halves, descend only where they differ.

**Likely questions**
- *What if many rows differ?* — Bisection degrades gracefully: many branches mismatch, and at worst it approaches a full row diff. I stop after `maxRows` differing rows (default 1,000) and mark the result `truncated` ("widespread mismatch").
- *Total DB work?* — Scans sum to ~2N rows (N + N/2 + N/4 …) per mismatched chunk, but only on the mismatched chunks.

**As built (`src/verify/bisect.ts`):** split each range at its **median key** (`ORDER BY pk OFFSET n/2 LIMIT 1` on whichever side has more rows), so halves are balanced even with sparse keys. Leaves hold ≤ 50 rows. Values are compared as `ARRAY[col::text, ...]`, which has no 100-argument limit, unlike `json_build_object`. Stats are recorded per run: hash rounds, rows fetched, depth.
**Measured:** across the eval scenarios, all seeded row changes were found (100%, 0 false rows) by fetching **311 rows**, while the mismatched tables held **6,079,997** rows (both sides). One changed row in 1M transactions reaches depth ≥ 7 (≈ log2(10000/50)).

---

## 5. Lock-impact simulator (F5) ⭐

**What:** Before running a migration, predicts which PostgreSQL lock each statement takes, what it blocks, and how risky it is for that table's size.

**How:** Parse each statement (using a real Postgres parser, e.g. `libpg-query`/`pgsql-ast-parser`), map it to a lock level, then score risk using `reltuples` (row estimate) and `pg_total_relation_size()`.

**The lock table you must know:**

| Statement | Lock | Blocks | Notes |
|---|---|---|---|
| `SELECT` | ACCESS SHARE | only ACCESS EXCLUSIVE | |
| `CREATE INDEX` | SHARE | **writes** | Reads OK, INSERT/UPDATE/DELETE wait |
| `CREATE INDEX CONCURRENTLY` | SHARE UPDATE EXCLUSIVE | nothing normal | Slower; can't run in a transaction; failure leaves an INVALID index |
| `ALTER TABLE ADD COLUMN` (nullable / constant default, PG 11+) | ACCESS EXCLUSIVE | **everything** | But instant (metadata only) |
| `ADD COLUMN ... DEFAULT random()` (volatile) | ACCESS EXCLUSIVE | everything | **Full table rewrite** |
| `ALTER COLUMN TYPE` | ACCESS EXCLUSIVE | everything | Usually full rewrite (except binary-compatible, e.g. increasing varchar length) |
| `SET NOT NULL` | ACCESS EXCLUSIVE | everything | Full scan (PG 12+ skips it if a valid `CHECK (col IS NOT NULL)` exists) |
| `ADD CONSTRAINT ... CHECK` | ACCESS EXCLUSIVE | everything | Scans table unless `NOT VALID` |
| `ADD FOREIGN KEY` | SHARE ROW EXCLUSIVE (both tables) | writes | Scans unless `NOT VALID` |
| `VALIDATE CONSTRAINT` | SHARE UPDATE EXCLUSIVE | nothing normal | The safe second step |
| `DROP COLUMN` / `DROP TABLE` | ACCESS EXCLUSIVE | everything | Fast but **data-lossy** |
| `VACUUM FULL` / `CLUSTER` | ACCESS EXCLUSIVE | everything | Full rewrite |

**The hidden danger — the lock queue:** Even an "instant" `ACCESS EXCLUSIVE` statement must *wait* for running transactions to finish. While it waits, **every new query queues behind it** — so a 1 ms ALTER can cause a multi-second outage. That's why DriftGuard always recommends `SET lock_timeout = '3s'` with retries.

**Row estimates are estimates.** `reltuples` is only filled in after `ANALYZE` (it's `-1` before that), and `pg_stat_user_tables.n_live_tup` can be stale. On a fresh seed I saw `n_live_tup = 100000` for a table with exactly 50,000 rows. That's why the seed runs `ANALYZE`, and why F5 (not built yet) will use them only to pick a size bucket, never as exact counts.

**Likely questions**
- *How accurate is it?* — Lock levels are deterministic from Postgres docs; duration is an estimate from table size. My eval ran 30 statements on a copy of the database and read the lock each one ACTUALLY took from `pg_locks`: 30/30 predicted modes matched. Rewrites were checked the same way via `pg_class.relfilenode`: 29/29.
- *Why not just run it on staging?* — Staging rarely has production-sized data or concurrent traffic; locks that are harmless there cause outages in production.

**As built (`src/locks/`):**
- Parser: **libpg-query**, the real Postgres 18 parser compiled to WebAssembly, so there's no native build. AST `location`s are **byte** offsets, so text is sliced from a UTF-8 buffer.
- Risk buckets from `reltuples` (an estimate; -1 before ANALYZE counts as "unknown", which is treated as high, never low): small < 100k, medium < 10M, large ≥ 10M. Doesn't block reads/writes = low. Blocks but metadata-only = medium, or **low if `SET lock_timeout` came earlier in the script**. Blocks while scanning/rewriting = medium/high/critical by size. Data loss = at least high.
- Script-level warnings: no `lock_timeout` before the first blocking statement, `CONCURRENTLY` inside `BEGIN`, several ACCESS EXCLUSIVE statements in one transaction.
- It tracks `CHECK (col IS NOT NULL)` added `NOT VALID` then `VALIDATE`d **within the same script**, so the later `SET NOT NULL` is correctly predicted not to scan. Without this, the safe rewrite itself looked risky.
- Binary-compatible type changes (growing a varchar, varchar→text, numeric precision up with the same scale) are recognized as no-rewrite when the current type is known from the target schema.
- Statements not in the rule table get a note saying so; they're never silently rated safe.

---

## 6. Safe-rewrite engine (F6) ⭐

**What:** Deterministically rewrites risky DDL into safe, multi-step equivalents (the **expand/contract** pattern).

**Rules:**
| Risky | Safe rewrite |
|---|---|
| `CREATE INDEX idx ON t(c)` | `CREATE INDEX CONCURRENTLY idx ON t(c)` (outside a transaction) |
| `ADD CONSTRAINT fk FOREIGN KEY ...` | `ADD CONSTRAINT fk ... NOT VALID;` then `VALIDATE CONSTRAINT fk;` |
| `ADD COLUMN c int NOT NULL DEFAULT f()` | add nullable → backfill in batches → add `CHECK (c IS NOT NULL) NOT VALID` → validate → `SET NOT NULL` |
| `ALTER COLUMN c TYPE bigint` | add new column → dual-write/backfill in batches → swap in app → drop old (contract) |
| `RENAME COLUMN` | add new column + keep old until app deploys (renames break running code instantly) |

Every generated script starts with `SET lock_timeout` and `SET statement_timeout`.

**Why rules, not the LLM?** These transformations must be correct every time. Rules are testable and predictable; an LLM might "usually" get them right, which isn't good enough for production data.

**Likely questions**
- *How do batched backfills avoid problems?* — `UPDATE ... WHERE id BETWEEN $1 AND $2` in small batches, each its own short transaction, with pauses — avoids long locks, huge WAL spikes, and replication lag.
- *What's expand/contract?* — First *expand* (add new structures compatible with old and new code), deploy code, then *contract* (remove old structures). Enables zero-downtime changes.

**As built (`src/rewrite/rewrite.ts`) — rules that actually exist:** `create_index_concurrently`, `drop_index_concurrently` (split one per index), `reindex_concurrently`, `foreign_key_not_valid`, `check_not_valid` (names unnamed constraints so `VALIDATE` can refer to them), `unique_using_index` (`CREATE UNIQUE INDEX CONCURRENTLY` + `ADD CONSTRAINT ... USING INDEX`), `add_column_expand`, `set_not_null_via_check`, `alter_type_expand_contract`, `rename_column_expand_contract`, `batched_write` (WHERE-less UPDATE/DELETE), and `table_rewrite_pg_repack` (manual advice).
- **Batched backfill is runnable:** a `DO` loop over the integer PK that `COMMIT`s after each batch (allowed in `DO` since PG 11), sleeps 50 ms between batches, and is idempotent (`WHERE col IS NULL`), so re-running after a failure resumes. It lifts `statement_timeout` around the loop, because the whole `DO` is one statement.
- Constant `DEFAULT` on `ADD COLUMN` is left alone: it's instant since PG 11. Only volatile defaults, serials, or `NOT NULL` without a default are rewritten.
- A bug the shadow eval caught: the type-change rewrite dropped the column's DEFAULT/NOT NULL. It now copies the default, enforces NOT NULL via the CHECK steps, and drops NOT NULL on `col_old` during the swap (the app stops writing it).
- **Measured under load** (probe query every ~10 ms on the 1M-row table): `CREATE INDEX` stalled the app **901 ms** vs **37 ms** rewritten. `ADD FOREIGN KEY` 612 → 8 ms. `ADD CHECK` 255 → 8 ms. `SET NOT NULL` 438 → 25 ms. Volatile-default `ADD COLUMN` 6.68 s → 583 ms (but 46 s total). `ALTER TYPE` 8.90 s → 174 ms (33 s total, plus manual steps). Single runs on an M1.

---

## 7. LLM planner with guardrails (F7) ⭐

**What:** The LLM turns the drift report + lock analysis into a readable, ordered migration plan with explanations — then code validates it.

**Flow:**
1. Build a prompt with the DriftReport, lock analysis, and safe-rewrite suggestions (only structured facts — no raw table data).
2. Ask for **structured output**: JSON matching a zod schema of `summary` + `steps[{title, sql, rationale}]`. Ollama is given the JSON Schema (from `z.toJSONSchema`) so generation is constrained. Risk, rollback SQL, reversibility and phase are **not** taken from the LLM: DriftGuard computes them from the parsed SQL.
3. **Validate:**
   - JSON parses and matches the schema?
   - Every table/column referenced exists in the introspected schema? (catches hallucinations)
   - Every statement type is on an allow-list, and passes the lock analyzer (no unsafe rewrite-able DDL)?
4. Invalid → retry once with the error message → still invalid → **fall back to the rules-only plan**.

**Why this design?** LLMs are good at ordering, explaining, and handling unusual combinations; they're unreliable on facts. So the LLM is an *advisor*, the validator is the *gatekeeper*. "The LLM proposes, code decides."

**Likely questions**
- *How do you stop hallucinated tables?* — Cross-check every identifier in the parsed SQL against the introspected schema.
- *Prompt injection?* — Database contents (comments, data) could contain text like "ignore previous instructions". I never pass row data to the LLM, treat all tool output as data, and the LLM has no write tools — so even a successful injection can't change anything.
- *Temperature?* — 0 for plans, for reproducibility; model name and version are recorded in the eval results.
- *Why Ollama?* — Free, local, private (schema never leaves your machine), and swappable via a provider interface.

**As built (`src/plan/`):**
- The deterministic **rules-only plan** is: drift → plain DDL (`desired.ts`) → F6 rewrites. It's the fallback, and it's also used without an LLM (`--no-llm`, or `DRIFTGUARD_LLM=none`).
- **Validator** (`validate.ts`): (1) every step parses; (2) allow-list: CREATE/ALTER TABLE, CREATE/DROP INDEX, DROP TABLE, UPDATE **with WHERE**, CREATE/ALTER SEQUENCE, SET lock/statement_timeout. `DO` blocks are rejected because their body is opaque PL/pgSQL; BEGIN/COMMIT, DELETE and TRUNCATE are rejected too. (3) A small "world" model of the target, updated as steps are applied, so step 5 may use a column step 2 adds, but a typo'd table or column fails. (4) Any statement for which F6 has a safe rewrite is rejected as unsafe.
- Loop: attempt 1, then a retry with the exact validator errors in the prompt, then fallback. An unreachable LLM also falls back, and never crashes.
- **Measured (llama3.2 3B, local, 17 drift scenarios, single run):** 5.9% valid on first try, 17.6% after one retry, 82.4% fell back to the rules plan. The 3 accepted LLM plans all **failed the shadow run** (0/3): they were safe but incomplete (e.g. re-created a dropped table without its index and identity sequence). Rules-only plans: 17/17 pass.
- *So is the LLM useless here?* — A 3B model on a laptop is, for planning. The point of the design is that it doesn't matter: the validator stopped every unsafe plan, and the shadow run caught every incomplete one. Lesson learned: "valid" (safe) is not "correct" (complete). The next step is to require a passing shadow run before accepting an LLM plan. A bigger model would likely score higher; I haven't measured one.

---

## 8. MCP server (F8)

**What MCP is:** The **Model Context Protocol** (introduced by Anthropic in late 2024) is an open standard that lets AI applications call external tools in a uniform way — "USB-C for AI tools".
- **Host/client:** the AI app (Claude Code, Cursor, Gemini CLI).
- **Server:** DriftGuard.
- **Messages:** JSON-RPC 2.0.
- **Transports:** `stdio` (local process — what DriftGuard uses) or Streamable HTTP (remote).
- **Primitives:** **tools** (functions the model can call), **resources** (readable data), **prompts** (templates).

**DriftGuard's tools:** `detect_drift`, `verify_data`, `find_differing_rows`, `analyze_locks`, `suggest_safe_rewrite`, `plan_migration`. Each has a JSON Schema (generated from zod) describing its inputs, so the model knows how to call it. All six are annotated `readOnlyHint: true`. `shadow` is deliberately CLI-only: it writes (to a throwaway container), so it stays out of the model's reach.

**Security design** (implemented in `docker/seed/00_roles.sql` and `src/db.ts`; proven by `tests/integration/readonly.test.ts`):
- **Layer 1, the role:** `driftguard_ro` only has `SELECT` (via `ALTER DEFAULT PRIVILEGES`, so tables created later are covered too). The role itself also defaults to `default_transaction_read_only = on`, `statement_timeout = 60s` and `idle_in_transaction_session_timeout = 60s`.
- **Layer 2, the session:** `createPool()` sends `default_transaction_read_only=on`, `statement_timeout`, `lock_timeout=5s` and `idle_in_transaction_session_timeout` in the connection's startup packet. So even a superuser URL gets a read-only session; a test proves this.
- The layers are independent. If someone runs `BEGIN READ WRITE`, layer 1 still refuses (`42501 insufficient_privilege`). If someone passes a superuser URL, layer 2 still refuses (`25006 read_only_sql_transaction`).
- **Why `lock_timeout` on a read-only tool?** Our `SELECT`s take ACCESS SHARE locks. If a migration is waiting for ACCESS EXCLUSIVE, we should give up quickly rather than hold locks in a long snapshot and extend someone else's outage.
- `driftguard doctor` asks the **server** (`current_setting`, `has_table_privilege`) whether the connection is read-only, rather than trusting our own config. It exits 1 if not.
- **No tool can write.** Plans are returned as SQL text for a human to review and apply.
- Connection strings come from local config/env, never from the model.

**Likely questions**
- *Why MCP instead of a REST API?* — One implementation works across every MCP-compatible assistant; the protocol handles tool discovery and schemas.
- *What is "agentic" here?* — The assistant decides which tools to call and in what order (e.g. detect drift → analyze locks → plan → verify), looping on results. DriftGuard provides safe, well-described tools for that loop.
- *Difference between tool calling and MCP?* — Tool calling is the model capability; MCP is the standard protocol for exposing tools to any model/app.

**As built (`src/mcp/server.ts`):** `find_differing_rows` returns only primary keys + changed column names unless `includeValues: true`. Row values in a fintech DB are PII, and could contain text that looks like instructions. Tool failures come back as MCP tool errors (`isError: true`) the model can read, not crashes. The integration test spawns `driftguard mcp` and talks to it with the official SDK client over stdio, exactly like Claude Code does. The CLI and MCP share one service class (`src/service.ts`), so they can't behave differently.

---

## 9. Eval suite (F9)

**What:** Automated measurement of how good DriftGuard is — the source of your résumé numbers.

**How:** `evals/scenarios/<name>/` contains:
- `setup.sql` — applied to the target DB to create a known drift (e.g. change a column type, drop an index, add a NOT NULL column).
- `expected.json` — the drift items and lock flags that *should* be found.

`npm run eval` makes a fresh scratch copy of the target for each scenario (`CREATE DATABASE ... TEMPLATE fintech STRATEGY FILE_COPY`, seconds instead of a 3-minute re-seed), applies `setup.sql`, runs DriftGuard, and reports:
- **Drift detection precision / recall**
- **Lock prediction accuracy**
- **Plan validity rate** (plans passing the guardrail validator) with the LLM, and fallback rate

**Likely questions**
- *Precision vs recall?* — Precision: of what I flagged, how much was real. Recall: of what was real, how much I found.
- *Aren't seeded scenarios biased?* — Yes; they measure known cases. I include tricky ones (volatile defaults, composite keys, partial indexes) and report the scenario list openly.
- *LLM results vary run to run?* — Temperature 0 and a fixed seed, and the model name is recorded in the results. Honest caveat: I ran the LLM eval once per scenario (a 3B model on a laptop is slow), so it's a single run, not an average.

**As built (`evals/`) — three kinds of evidence:**
1. **21 scenarios** (`evals/scenarios/*/setup.sql` + `expected.json`): 16 schema-drift, 3 data-drift, 1 "session settings" false-positive trap, 1 combined. Results: drift **100% precision / 100% recall** (23 TP, 0 FP, 0 FN), data rows 100% found, **17/17 rules-only plans pass the shadow run**.
2. **Lock accuracy with ground truth from Postgres**, not from my own table: each statement runs inside `BEGIN ... ROLLBACK` and I read `pg_locks` for this backend. Non-transactional statements (`CONCURRENTLY`, `VACUUM FULL`) are observed from a second session that holds only ACCESS SHARE, so the statement takes its early locks and then waits. My first version held ACCESS EXCLUSIVE and so only saw `VACUUM FULL`'s initial ACCESS SHARE; that measurement bug is fixed. **30/30 modes, 29/29 rewrites.**
3. **Stall benchmark:** the original vs rewritten migration on fresh 1M-row copies while a probe queries the table (numbers in F6 above).
- *Isn't 100% suspicious?* — Yes, which is why the scenarios and the corpus are public and the lock truth is measured. They're cases I wrote, so they show the tool does what it claims on known shapes, not that it's perfect on unknown ones.

---

## 10. Shadow verification (F10) ⭐

**What:** Proves the migration works before touching the real database.

**How:** Start a throwaway `postgres:16-alpine` container (random localhost port, random password), copy the target's **schema** into it with the `pg_dump | psql` that ship inside that image (so no local Postgres tools are needed), apply the plan one statement at a time exactly as a human would, then introspect the result and diff it against the source. Neon branches are on the roadmap; not built.

**Why:** "The plan looks right" becomes "the plan was executed and verified." Neon branching makes it cheap because branches share storage until modified.

**Likely question**
- *Does a shadow run prove production safety?* — It proves correctness of the result, not production timing under load; that's why it's combined with the lock analyzer.

**As built (`src/shadow/`):** schema-only (no data leaves the target), so it proves the resulting **structure**, not timing or data. Each statement runs separately, because `CONCURRENTLY` and `COMMIT`-inside-`DO` fail in a multi-statement (implicit transaction) query. Verdict = no step failed AND the remaining drift only contains items intentionally left: skipped contract steps (extra tables/columns) and manual items (PK changes). ~4–5 s per run. Containers are started with `execFile` (no shell) and removed in a `finally`.

---

## 11. Reversibility classifier & migration receipt (F11, F12)

**Reversibility:** Each step is tagged `reversible` (e.g. add index → drop index), `reversible-with-backfill` (e.g. type change), or `data-lossy` (e.g. drop column — data is gone). Rollback SQL is generated where possible; data-lossy steps require explicit confirmation.

**Receipt:** A JSON document with drift report, plan, lock analysis, and verification results, plus a SHA-256 hash of its canonical (sorted-key) form. It's an audit trail — relevant in fintech, where you must show what changed and that it was verified.

*Is the hash a signature?* — No. It detects accidental or later modification (tamper-evidence) if the hash is stored elsewhere; a real signature (e.g. Ed25519) would add proof of who produced it — a possible extension.

**As built:** `src/reversibility/classify.ts` uses the pre-migration schema to build real rollbacks (old default, old type, old index/constraint definition). Contract (data-lossy) steps are **commented out** in the rendered plan unless `--allow-data-loss`, and skipped in shadow runs. Receipts: `driftguard receipt` writes the file, `driftguard receipt-verify` recomputes the hash. Canonical JSON = keys sorted at every level; `undefined` dropped like `JSON.stringify`.

---

## 12. General questions you should prepare

**Why not Flyway / Liquibase / Atlas?**
They **manage and apply** versioned migrations. DriftGuard focuses on **analysis and proof**: lock impact, safe rewrites, data verification, and an AI interface. It complements them — you could run DriftGuard on a Flyway migration before applying it. (Linters like *squawk* flag risky SQL; DriftGuard adds data verification, bisection, and guarded AI planning.)

**What was the hardest part?**
Pick the one that was genuinely hardest for you — likely deterministic checksums (formatting/timezone issues) or the guardrail validator (parsing SQL reliably).

**How would you scale it to a 1 TB database?**
Parallelize chunk hashing across connections, run on a read replica to avoid primary load, sample-verify hot tables, and checkpoint progress so verification can resume.

**How did you test it?**
Unit tests for pure logic (diff, lock rules, rewrites), integration tests against Dockerized Postgres, and the eval suite for end-to-end quality. CI runs all of it on every push.

**What would you do next?**
MySQL support, logical-replication-aware verification (compare at a known LSN), a GitHub Action that comments lock analysis on migration pull requests.

**What did you learn?**
Postgres locking internals, that "instant" DDL can still cause outages via the lock queue, and how to put LLMs behind deterministic guardrails.

---

## 13. Numbers to fill in once built (only real ones)

| Metric | Your result |
|---|---|
| Eval scenarios | [N] |
| Drift detection precision / recall | [X]% / [Y]% |
| Lock prediction accuracy | [X]% |
| LLM plan validity (before fallback) | 5.9% first try / 17.6% after retry (llama3.2 3B); 0/3 accepted plans passed shadow |
| Bisection: rows fetched vs full diff on 1M-row table | [X] vs 1,000,000 |
| Test count | [N] |
