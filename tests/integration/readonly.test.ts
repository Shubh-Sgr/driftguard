import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db.js";
import { inspectConnection } from "../../src/cli/doctor.js";
import { SEED_TRANSACTIONS, SOURCE_ADMIN_URL, SOURCE_RO_URL, TARGET_RO_URL } from "./env.js";

// Postgres SQLSTATE codes we expect to see.
const READ_ONLY_TRANSACTION = "25006";
const INSUFFICIENT_PRIVILEGE = "42501";
const QUERY_CANCELED = "57014"; // what statement_timeout raises

// 30 s: the seed test counts 3M rows, which can be slow on shared CI runners.
const ro = createPool(SOURCE_RO_URL, { statementTimeoutMs: 30_000 });
const target = createPool(TARGET_RO_URL, { statementTimeoutMs: 30_000 });
// Superuser credentials, but opened through createPool: proves the session layer alone blocks writes.
const adminViaPgVouch = createPool(SOURCE_ADMIN_URL, { statementTimeoutMs: 5_000 });

afterAll(async () => {
  await Promise.all([ro.end(), target.end(), adminViaPgVouch.end()]);
});

describe("read-only safety layers", () => {
  it("layer 1+2: the read-only role cannot create tables", async () => {
    await expect(ro.query("CREATE TABLE should_fail (id int)")).rejects.toMatchObject({
      code: READ_ONLY_TRANSACTION,
    });
  });

  it("layer 1: even inside an explicit READ WRITE transaction, the role lacks write privileges", async () => {
    const client = await ro.connect();
    try {
      await client.query("BEGIN READ WRITE");
      await expect(
        client.query("UPDATE accounts SET balance = 0 WHERE id = 1"),
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("layer 2: a superuser connection opened by PgVouch is still read-only", async () => {
    await expect(
      adminViaPgVouch.query("UPDATE accounts SET balance = 0 WHERE id = 1"),
    ).rejects.toMatchObject({ code: READ_ONLY_TRANSACTION });
  });

  it("statement_timeout cancels slow queries", async () => {
    const fast = createPool(SOURCE_RO_URL, { statementTimeoutMs: 200 });
    try {
      await expect(fast.query("SELECT pg_sleep(2)")).rejects.toMatchObject({ code: QUERY_CANCELED });
    } finally {
      await fast.end();
    }
  });

  it("doctor reports the connection as safe", async () => {
    const report = await inspectConnection(ro);
    expect(report).toMatchObject({
      user: "pgvouch_ro",
      readOnly: true,
      statementTimeout: "30s",
      canWriteAnyTable: false,
      tableCount: 10,
    });
    // CI runs this on every supported major version (PG_VERSION), locally 16 by default.
    expect(report.serverVersion).toMatch(new RegExp(`^${process.env.PG_VERSION ?? "16"}\\.`));
  });
});

describe("seed", () => {
  // Exact counts (not reltuples estimates) on both databases.
  const countSql = `
    SELECT (SELECT count(*) FROM transactions)   AS transactions,
           (SELECT count(*) FROM ledger_entries) AS ledger_entries,
           (SELECT count(*) FROM accounts)       AS accounts`;

  it("loads the expected volume into source and target identically", async () => {
    const [s, t] = await Promise.all([ro.query(countSql), target.query(countSql)]);
    expect(s.rows[0]).toEqual({ transactions: String(SEED_TRANSACTIONS), ledger_entries: String(2 * SEED_TRANSACTIONS), accounts: "20000" });
    expect(t.rows[0]).toEqual(s.rows[0]);
  });

  it("has planner statistics so reltuples is usable later (F5)", async () => {
    const { rows } = await ro.query<{ reltuples: number }>(
      "SELECT reltuples FROM pg_class WHERE oid = 'public.transactions'::regclass",
    );
    // An estimate, so only check it's populated and in the right range.
    expect(rows[0]!.reltuples).toBeGreaterThan(0.9 * SEED_TRANSACTIONS);
  });
});
