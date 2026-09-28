# DriftGuard — Build & Deployment Plan

> **One line:** DriftGuard is an MCP server + CLI that lets AI assistants (Claude Code, Cursor, Gemini CLI) safely inspect, plan, and *prove* PostgreSQL migrations — the LLM proposes, deterministic rules decide.

Cost: **₹0** (local Docker + free tiers). Time: **~4 weeks** at 3–4 hrs/day.

---

## 1. The problem (your interview opening)

At FinacPlus you migrated 100+ tables from AWS to GCP. The hard parts were never "write the ALTER statement" — they were:

1. **Knowing what differs** between two databases (schema drift).
2. **Knowing what a migration will lock**, and for how long, before running it in production.
3. **Proving** the data is identical afterwards — not "row counts match", but *proof*.
4. **Finding the exact rows** that differ when proof fails.

AI assistants can now write migrations, but they hallucinate objects, ignore locks, and can't prove anything. DriftGuard gives them safe, read-only tools and wraps every AI suggestion in deterministic checks.

---

## 2. Feature list

### Core (MVP — must ship)
| # | Feature | What it does |
|---|---|---|
| F1 | **Schema introspection** | Reads tables, columns, types, defaults, nullability, indexes, constraints, sequences from `pg_catalog` into a typed model. |
| F2 | **Drift detection** | Pure function: `diff(sourceSchema, targetSchema) → DriftReport` (missing/extra/changed objects). |
| F3 | **Chunked checksum verification** | Splits each table by primary-key ranges, computes an MD5 per chunk on both DBs, compares. Never loads a full table into memory. |
| F4 | **Checksum bisection** ⭐ | When a chunk mismatches, recursively halves it until it finds the **exact differing rows** — O(log n) queries instead of a full row-by-row diff. |
| F5 | **Lock-impact simulator** ⭐ | For every DDL statement, predicts the PostgreSQL lock level (e.g. `ACCESS EXCLUSIVE`), which queries it will block (reads? writes?), and a risk score using table size from `pg_class.reltuples`. |
| F6 | **Safe-rewrite engine** ⭐ | Deterministic rules that turn risky DDL into safe multi-step versions (e.g. `CREATE INDEX` → `CREATE INDEX CONCURRENTLY`; `ADD CONSTRAINT` → `NOT VALID` + `VALIDATE`; `ADD COLUMN NOT NULL` → add nullable → backfill in batches → set NOT NULL). |
| F7 | **LLM migration planner with guardrails** ⭐ | LLM receives the DriftReport + lock analysis and returns a structured plan (validated with zod). A **validator rejects** any plan that references non-existent objects or contains unsafe statements, then falls back to a rules-only plan. |
| F8 | **MCP server** | Exposes F1–F7 as MCP tools so any AI assistant can call them. Read-only DB role. |
| F9 | **Eval suite** | 20+ seeded drift scenarios; scores detection precision/recall, lock-prediction accuracy, and plan validity. **Produces the real numbers for your résumé.** |

### Differentiators (week 4 — stretch)
| # | Feature | What it does |
|---|---|---|
| F10 | **Shadow verification** ⭐ | Applies the plan to a throwaway copy (Docker container locally, or a free **Neon branch** online), then re-runs drift + checksums to *prove* the migration produces the expected schema before it ever touches the real DB. |
| F11 | **Reversibility classifier** | Tags each step `reversible`, `reversible-with-backfill`, or `data-lossy` (e.g. `DROP COLUMN`) and generates rollback SQL where possible. |
| F12 | **Migration receipt** | A JSON report (drift + plan + lock analysis + verification results) with a SHA-256 hash — an audit trail, important in fintech. |

⭐ = the parts that make this project stand out.

---

## 3. Architecture (easy to explain)

```
 AI assistant (Claude Code / Cursor)          You (terminal)
            │  MCP (JSON-RPC over stdio)             │ CLI
            ▼                                        ▼
 ┌──────────────────────── DriftGuard core ─────────────────────────┐
 │  introspect ──► diff ──► lock-analyzer ──► safe-rewrite          │
 │                                  │                               │
 │                        LLM planner ──► guardrail validator       │
 │                                                  │ (reject → rules-only plan)
 │  verify (chunked checksums ──► bisection)        │               │
 │  shadow-run (optional) ──► receipt               ▼               │
 └──────────────────────────────────────────────────────────────────┘
            │ read-only SQL                    │ HTTP (optional)
            ▼                                  ▼
   source DB    target DB              Ollama (local) / Gemini free tier
```

**Golden rule to repeat in interviews:** *The LLM never touches the database and never decides pass/fail. It only proposes; code verifies.*

---

## 4. Tech stack (all free)

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript, Node 20+ | Your strongest stack |
| DB driver | `pg` | Standard, supports cursors & parameterized queries |
| Validation | `zod` | Validates LLM JSON output and tool inputs |
| MCP | `@modelcontextprotocol/sdk` | Official SDK |
| CLI | `commander` | Simple |
| Tests | `vitest` | Fast, TS-native |
| Local DBs | Docker Compose (2× Postgres 16) | Free |
| LLM | **Ollama** (local, default) or **Gemini API free tier** | Free; behind a provider interface |
| CI | GitHub Actions | Free for public repos |

---

## 5. Folder structure

```
driftguard/
├── src/
│   ├── introspect/     # F1  read schema from pg_catalog
│   ├── diff/           # F2  pure diff functions
│   ├── locks/          # F5  lock-level rules + risk scoring
│   ├── rewrite/        # F6  safe-rewrite rules
│   ├── verify/         # F3, F4 checksums + bisection
│   ├── plan/           # F7  LLM planner + guardrail validator
│   ├── llm/            # provider interface: ollama.ts, gemini.ts
│   ├── shadow/         # F10 shadow runs
│   ├── receipt/        # F12
│   ├── mcp/            # F8  MCP server + tool definitions
│   └── cli/            # commands: diff, verify, locks, plan, shadow
├── evals/
│   ├── scenarios/      # F9  one folder per seeded drift case
│   └── run.ts
├── docker/
│   ├── docker-compose.yml
│   └── seed/           # fintech schema: accounts, transactions, ledger_entries
├── docs/
│   └── ARCHITECTURE.md
├── .github/workflows/ci.yml
└── README.md
```

---

## 6. Week-by-week plan

### Week 1 — Foundations (F1, F2, F3)
- Day 1: repo + git identity (Section 8), Docker Compose with `source-db` and `target-db`, seed a fintech schema (~10 tables; 1M rows in `transactions` via `generate_series`).
- Day 2–3: **F1** introspection from `pg_catalog` → typed `Schema` object. Unit tests.
- Day 4: **F2** `diffSchemas()` — pure function, one test per drift type.
- Day 5–6: **F3** chunked checksums: `SELECT md5(string_agg(t::text, '' ORDER BY id)) FROM t WHERE id BETWEEN $1 AND $2`.
- Day 7: CLI `driftguard diff` and `driftguard verify`. **Commit + push.**

### Week 2 — The standout pieces (F4, F5, F6)
- Day 8–9: **F4** bisection: mismatched chunk → split in half → recurse until ≤ 50 rows → row-level diff.
- Day 10–12: **F5** lock analyzer: map each DDL type to its lock level (table in the interview guide), estimate impact from `reltuples` + `pg_total_relation_size`.
- Day 13–14: **F6** safe-rewrite rules with before/after tests.

### Week 3 — AI + MCP (F7, F8)
- Day 15: LLM provider interface + Ollama adapter (`qwen2.5-coder` or `llama3.1`); Gemini adapter optional.
- Day 16–17: **F7** planner: prompt with DriftReport + lock analysis → zod-validated JSON plan → **guardrail validator** (objects exist? statements allow-listed?) → fallback.
- Day 18–20: **F8** MCP server with tools: `detect_drift`, `verify_data`, `find_differing_rows`, `analyze_locks`, `suggest_safe_rewrite`, `plan_migration`. Test inside Claude Code / Cursor / Gemini CLI.
- Day 21: Record a 2-minute demo video.

### Week 4 — Proof + polish (F9, F10–F12)
- Day 22–24: **F9** eval suite — 20 scenarios, markdown results table. **These are your résumé numbers.**
- Day 25–26: **F10** shadow verification (Docker locally; Neon branch in the online demo).
- Day 27: F11 + F12 if time allows.
- Day 28: README (problem, diagram, quickstart, eval table, design decisions, limitations), CI, publish.

---

## 7. Zero-cost deployment

| What | Where | Cost |
|---|---|---|
| Source code | GitHub public repo | Free |
| Package | **npm** → `npx driftguard diff ...` | Free |
| Docker image | **GitHub Container Registry (ghcr.io)** via GitHub Actions | Free for public |
| Online demo DBs | **Neon free tier** — use *branching* for source/target and shadow runs | Free |
| Online demo API (optional) | **Render** free web service (sleeps when idle) | Free |
| LLM online | **Gemini API free tier** (Ollama can't run on Render free) | Free |
| Demo video | Loom free / OBS | Free |

**Safety rule for any public demo:** only run against your own seeded demo databases. Never accept user-supplied connection strings.

---

## 8. Commits under your name only

Run once inside the repo:

```bash
git config user.name "Shubh-Sgr"
```

```bash
git config user.email "YOUR_ID+Shubh-Sgr@users.noreply.github.com"
```

(Find your exact noreply address at GitHub → Settings → Emails. It hides your personal email.)

If you use an AI coding tool, turn off its automatic co-author line. In Claude Code, add this to `~/.claude/settings.json`:

```json
{ "includeCoAuthoredBy": false }
```

Before each push, check with:

```bash
git log --format='%an <%ae>%n%b' -5
```

Rules for yourself: small commits, meaningful messages (`feat(verify): add checksum bisection`), and **read and understand every diff before committing** — interviewers will ask about any line.

---

## 9. Build prompt (paste into your coding tool, one milestone at a time)

```
You are helping me build DriftGuard, an open-source MCP server + CLI for safe PostgreSQL
migrations. I am a backend engineer (TypeScript, Node.js, PostgreSQL) and I must understand
every line, so write clean code with short comments explaining non-obvious decisions.

Constraints: zero cost (Docker Postgres, Ollama default, Gemini free tier optional),
read-only DB access, parameterized queries, never load full tables into memory,
LLM never executes SQL and never decides pass/fail.

Stack: TypeScript, Node 20, pg, zod, @modelcontextprotocol/sdk, commander, vitest.
Follow the folder structure and features F1–F12 in DriftGuard_Plan.md.

Work ONE milestone at a time. After each: list files changed, how to run it,
and 3 interview questions about the design with short answers. Then stop and wait.

Start with Week 1, Day 1.
```

---

## 10. Résumé bullets (fill ONLY with your real eval results)

- Built DriftGuard, an MCP server that lets AI assistants detect PostgreSQL schema drift and verify data integrity via chunked checksums with bisection, locating differing rows in O(log n) queries.
- Designed a lock-impact analyzer and safe-rewrite engine that flagged **[X] of [N]** risky DDL statements in seeded scenarios and rewrote them into non-blocking steps.
- Guarded LLM-generated migration plans with schema-aware validation, achieving **[X]%** valid plans across **[N]** eval scenarios with deterministic fallback.
