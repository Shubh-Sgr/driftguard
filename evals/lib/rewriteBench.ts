import pg from "pg";
import { createPool } from "../../src/db.js";
import { introspect } from "../../src/introspect/introspect.js";
import { rewriteMigration } from "../../src/rewrite/rewrite.js";
import { parseSql } from "../../src/sql/parse.js";
import { createScratchDatabase, dropScratchDatabase, runAsAdmin, TARGET_ADMIN_URL, TARGET_RO_URL, withDatabase } from "./scratch.js";

interface BenchCase {
  name: string;
  sql: string;
  /** Extra setup on the copy before the migration (not timed). */
  prep?: string;
  /** Simulated application traffic that runs during the migration. */
  probe: { sql: string; maxId: number };
}

// Every case runs on the seeded 1M-row `transactions` (or 2M-row `ledger_entries`).
const CASES: BenchCase[] = [
  { name: "CREATE INDEX", sql: "CREATE INDEX idx_amount ON transactions (amount)", probe: { sql: "UPDATE transactions SET status = status WHERE id = $1", maxId: 1_000_000 } },
  { name: "ADD FOREIGN KEY", sql: "ALTER TABLE ledger_entries ADD CONSTRAINT le_account_fk2 FOREIGN KEY (account_id) REFERENCES accounts (id)", probe: { sql: "UPDATE ledger_entries SET amount = amount WHERE id = $1", maxId: 2_000_000 } },
  { name: "ADD CHECK", sql: "ALTER TABLE transactions ADD CONSTRAINT amount_positive CHECK (amount > 0)", probe: { sql: "SELECT amount FROM transactions WHERE id = $1", maxId: 1_000_000 } },
  {
    name: "SET NOT NULL",
    prep: "ALTER TABLE transactions ADD COLUMN channel text DEFAULT 'app'",
    sql: "ALTER TABLE transactions ALTER COLUMN channel SET NOT NULL",
    probe: { sql: "SELECT amount FROM transactions WHERE id = $1", maxId: 1_000_000 },
  },
  { name: "ADD COLUMN volatile DEFAULT", sql: "ALTER TABLE transactions ADD COLUMN ref uuid NOT NULL DEFAULT gen_random_uuid()", probe: { sql: "SELECT amount FROM transactions WHERE id = $1", maxId: 1_000_000 } },
  { name: "ALTER COLUMN TYPE", sql: "ALTER TABLE transactions ALTER COLUMN merchant_id TYPE bigint", probe: { sql: "SELECT amount FROM transactions WHERE id = $1", maxId: 1_000_000 } },
];

export interface RunStats {
  ok: boolean;
  error?: string;
  /** Wall time of the whole migration. */
  durationMs: number;
  /** Longest single probe query: how long the application was stalled. */
  maxStallMs: number;
  probes: number;
}

export interface BenchResult {
  name: string;
  sql: string;
  original: RunStats;
  rewritten: RunStats;
  rewrittenSteps: number;
  manualStepsSkipped: number;
}

/**
 * Runs each risky statement and its DriftGuard rewrite on separate fresh copies of the
 * 1M-row database while a probe keeps querying the table (like live app traffic).
 * The probe's worst latency = how long the migration blocked the application.
 */
export async function runRewriteBench(log = console.log): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  for (const c of CASES) {
    log(`[rewrite] ${c.name}: original`);
    const original = await onFreshCopy(c, async () => (await parseSql(c.sql)).map((s) => s.text));

    log(`[rewrite] ${c.name}: rewritten`);
    let rewrittenSteps = 0;
    let manualStepsSkipped = 0;
    const rewritten = await onFreshCopy(c, async (roUrl) => {
      const ro = createPool(roUrl, { statementTimeoutMs: 60_000 });
      const schema = await introspect(ro);
      await ro.end();
      const r = await rewriteMigration(c.sql, { schema });
      const steps = r.statements.flatMap((s) => s.steps);
      manualStepsSkipped = steps.filter((s) => s.kind === "manual").length;
      rewrittenSteps = steps.length - manualStepsSkipped;
      // Run exactly what the generated script would run: its SET header, then each step.
      const sql = ["SET lock_timeout = '3s'", "SET statement_timeout = '30min'", ...steps.filter((s) => s.kind !== "manual").map((s) => s.sql)];
      const statements: string[] = [];
      for (const part of sql) for (const s of await parseSql(part)) statements.push(s.text);
      return statements;
    });

    results.push({ name: c.name, sql: c.sql, original, rewritten, rewrittenSteps, manualStepsSkipped });
  }
  return results;
}

async function onFreshCopy(c: BenchCase, statementsFor: (roUrl: string) => Promise<string[]>): Promise<RunStats> {
  const db = "eval_bench";
  await createScratchDatabase(TARGET_ADMIN_URL, db);
  try {
    if (c.prep) await runAsAdmin(TARGET_ADMIN_URL, db, c.prep);
    const statements = await statementsFor(withDatabase(TARGET_RO_URL, db));
    const url = withDatabase(TARGET_ADMIN_URL, db);

    const migrator = new pg.Client({ connectionString: url });
    const app = new pg.Client({ connectionString: url });
    await migrator.connect();
    await app.connect();
    try {
      const probe = startProbe(app, c.probe);
      await sleep(300); // baseline traffic before the migration starts
      const t0 = Date.now();
      let error: string | undefined;
      try {
        for (const s of statements) await migrator.query(s);
      } catch (err) {
        error = (err as Error).message;
      }
      const durationMs = Date.now() - t0;
      await sleep(300);
      const stats = await probe.stop();
      return { ok: !error, error, durationMs, ...stats };
    } finally {
      await migrator.end();
      await app.end();
    }
  } finally {
    await dropScratchDatabase(TARGET_ADMIN_URL, db);
  }
}

/** Issues one small query every ~10 ms and records the slowest one. */
function startProbe(client: pg.Client, probe: BenchCase["probe"]) {
  let running = true;
  let maxStallMs = 0;
  let probes = 0;
  let id = 1;
  const loop = (async () => {
    while (running) {
      // Deterministic spread of ids (no randomness in the benchmark).
      id = (id * 7919) % probe.maxId || 1;
      const t = Date.now();
      await client.query(probe.sql, [id]);
      maxStallMs = Math.max(maxStallMs, Date.now() - t);
      probes++;
      await sleep(10);
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return { maxStallMs, probes };
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
