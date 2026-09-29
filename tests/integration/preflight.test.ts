import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createPool } from "../../src/db.js";
import { analyzeMigration } from "../../src/locks/analyze.js";
import { evaluatePreflight, readLockActivity } from "../../src/locks/preflight.js";
import { DriftGuard } from "../../src/service.js";
import { createScratchDatabase, dropScratchDatabase, runAsAdmin, withDatabase } from "../../evals/lib/scratch.js";
import { SOURCE_RO_URL, TARGET_ADMIN_URL, TARGET_RO_URL } from "./env.js";

// A real idle-in-transaction session holds ACCESS SHARE on accounts in a scratch copy
// of the target, and the preflight has to notice it.
const DB = "dg_test_preflight";
const NO_STATS_ROLE = "dg_test_nostats";
const SECRET = "secret-marker-7f3a"; // appears only in the holder's query text

let holder: pg.Client;
let holderPid: number;
let dg: DriftGuard;

beforeAll(async () => {
  await createScratchDatabase(TARGET_ADMIN_URL, DB);
  await runAsAdmin(TARGET_ADMIN_URL, DB, `
    -- The seed grants this too; repeated so databases seeded before it still pass.
    GRANT pg_read_all_stats TO driftguard_ro;
    -- A role WITHOUT pg_read_all_stats, to test "limited visibility".
    DROP ROLE IF EXISTS ${NO_STATS_ROLE};
    CREATE ROLE ${NO_STATS_ROLE} LOGIN PASSWORD 'nostats_local';
    GRANT CONNECT ON DATABASE ${DB} TO ${NO_STATS_ROLE};
  `);

  holder = new pg.Client({ connectionString: withDatabase(TARGET_ADMIN_URL, DB), application_name: "dg-test-holder" });
  await holder.connect();
  holderPid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  await holder.query("BEGIN");
  await holder.query(`SELECT 1 FROM accounts WHERE id = -1 AND '${SECRET}' <> ''`); // takes ACCESS SHARE, then idles

  dg = new DriftGuard(loadConfig({ SOURCE_DATABASE_URL: SOURCE_RO_URL, TARGET_DATABASE_URL: withDatabase(TARGET_RO_URL, DB), DRIFTGUARD_LLM: "none" }));
});

afterAll(async () => {
  await holder?.query("ROLLBACK").catch(() => undefined);
  await holder?.end();
  await dg?.close();
  await dropScratchDatabase(TARGET_ADMIN_URL, DB);
  await runAsAdmin(TARGET_ADMIN_URL, "postgres", `DROP ROLE IF EXISTS ${NO_STATS_ROLE}`);
});

describe("preflight: is it safe to run right now?", () => {
  it("ALTER TABLE would wait behind the idle-in-transaction session", async () => {
    const r = await dg.preflight("ALTER TABLE accounts ADD COLUMN x int");
    expect(r).toMatchObject({ verdict: "would_wait", visibility: "full", blockingSessions: 1 });
    const blocker = r.statements[0]!.waitsFor[0]!;
    expect(blocker.session).toMatchObject({ pid: holderPid, user: "postgres", applicationName: "dg-test-holder", state: "idle in transaction" });
    expect(blocker.session.transactionAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(r.longTransactions.map((s) => s.pid)).toContain(holderPid);
    // Never the other session's query text (it could contain personal data).
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("a SELECT is safe now (ACCESS SHARE doesn't conflict with ACCESS SHARE)", async () => {
    expect((await dg.preflight("SELECT * FROM accounts")).verdict).toBe("safe_now");
  });

  it("CREATE INDEX CONCURRENTLY on another table still waits for the open transaction", async () => {
    const r = await dg.preflight("CREATE INDEX CONCURRENTLY i ON customers (country)");
    expect(r.verdict).toBe("would_wait");
    expect(r.statements[0]!.waitsFor.map((b) => b.session.pid)).toContain(holderPid);
  });

  it("degrades gracefully without pg_read_all_stats: conflicts found, ages unknown", async () => {
    const url = withDatabase(TARGET_RO_URL, DB).replace("driftguard_ro:driftguard_ro_local", `${NO_STATS_ROLE}:nostats_local`);
    const pool = createPool(url, { statementTimeoutMs: 10_000 });
    try {
      const activity = await readLockActivity(pool, ["public.accounts"]);
      const r = evaluatePreflight(await analyzeMigration("ALTER TABLE accounts ADD COLUMN x int"), activity);
      expect(r).toMatchObject({ verdict: "would_wait", visibility: "limited" });
      expect(r.statements[0]!.waitsFor[0]!.session).toMatchObject({ pid: holderPid, state: null, transactionAgeSeconds: null });
      expect(r.notes[0]).toMatch(/Limited visibility/);
    } finally {
      await pool.end();
    }
  });
});
