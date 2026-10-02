import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db.js";
import { verifyData } from "../../src/verify/verify.js";
import { createScratchDatabase, dropScratchDatabase, runAsAdmin, withDatabase } from "../../evals/lib/scratch.js";
import { SEED_TRANSACTIONS, SOURCE_RO_URL, TARGET_ADMIN_URL, TARGET_RO_URL } from "./env.js";

// A scratch copy of the target with a few known data differences. Row ids scale with
// the seed (543210 and 1500001 at the default 1M), so the test works for small CI seeds.
const DB = "dg_test_verify";
const N = SEED_TRANSACTIONS;
const CHANGED_TX = Math.floor(N * 0.54321);
const MISSING_LEDGER = [Math.floor(N * 1.5) + 1, Math.floor(N * 1.5) + 2];

let source: pg.Pool;
let target: pg.Pool;

beforeAll(async () => {
  await createScratchDatabase(TARGET_ADMIN_URL, DB);
  await runAsAdmin(TARGET_ADMIN_URL, DB, `
    UPDATE transactions SET amount = amount + 0.01 WHERE id = ${CHANGED_TX};  -- one changed row
    DELETE FROM ledger_entries WHERE id IN (${MISSING_LEDGER.join(", ")});   -- rows missing on target
    UPDATE account_limits SET amount = 1 WHERE account_id = 777 AND limit_type = 'atm_withdrawal'; -- composite PK
    UPDATE fx_rates SET rate = rate + 0.000001 WHERE base = 'USD' AND quote = 'INR' AND as_of = '2024-03-01'; -- no PK
    -- A different server default must NOT create false mismatches (timestamps are normalized to UTC).
    ALTER DATABASE ${DB} SET TimeZone = 'Asia/Kolkata';
  `);
  source = createPool(SOURCE_RO_URL, { statementTimeoutMs: 60_000 });
  target = createPool(withDatabase(TARGET_RO_URL, DB), { statementTimeoutMs: 60_000 });
});

afterAll(async () => {
  await Promise.all([source?.end(), target?.end()]);
  await dropScratchDatabase(TARGET_ADMIN_URL, DB);
});

describe("verifyData (F3) + bisection (F4)", () => {
  it("finds the exact changed row among all transactions while fetching very few rows", async () => {
    const report = await verifyData(source, target, { tables: ["transactions"], findRows: true });
    const t = report.tables[0]!;

    expect(t).toMatchObject({ status: "mismatch", sourceRows: N, targetRows: N, chunks: Math.ceil(N / 10_000) });
    expect(t.mismatchedChunks).toHaveLength(1);
    expect(t.differingRows).toEqual([
      expect.objectContaining({ kind: "changed", key: { id: String(CHANGED_TX) }, columns: ["amount"] }),
    ]);
    const row = t.differingRows![0]!;
    if (row.kind === "changed") expect(Number(row.target.amount) - Number(row.source.amount)).toBeCloseTo(0.01);

    // One 10k-row chunk bisected to a <=50-row leaf: at most ~100 rows fetched (both sides),
    // instead of 2 x 1,000,000 for a naive row-by-row comparison.
    expect(t.bisect!.rowsFetched).toBeLessThanOrEqual(100);
    expect(t.bisect!.maxDepth).toBeGreaterThanOrEqual(7); // log2(10000/50) ≈ 7.6
  });

  it("reports rows missing on the target", async () => {
    const report = await verifyData(source, target, { tables: ["ledger_entries"], findRows: true });
    const t = report.tables[0]!;
    expect(t.targetRows).toBe(t.sourceRows - 2);
    expect(t.differingRows!.map((r) => [r.kind, r.key])).toEqual([
      ["missing_in_target", { id: String(MISSING_LEDGER[0]) }],
      ["missing_in_target", { id: String(MISSING_LEDGER[1]) }],
    ]);
  });

  it("handles composite primary keys", async () => {
    const report = await verifyData(source, target, { tables: ["account_limits"], findRows: true, chunkSize: 5000 });
    expect(report.tables[0]!.differingRows).toEqual([
      expect.objectContaining({ kind: "changed", key: { account_id: "777", limit_type: "atm_withdrawal" }, columns: ["amount"] }),
    ]);
  });

  it("detects but cannot localize a change in a table without a primary key", async () => {
    const report = await verifyData(source, target, { tables: ["fx_rates"], findRows: true });
    expect(report.tables[0]).toMatchObject({ status: "mismatch", localized: false });
    expect(report.tables[0]!.reason).toMatch(/cannot be localized/);
  });

  it("does not report false mismatches when the target's TimeZone differs", async () => {
    // customers/accounts have timestamptz columns and were not modified.
    const report = await verifyData(source, target, { tables: ["customers", "accounts", "audit_log"] });
    expect(report.tables.map((t) => t.status)).toEqual(["match", "match", "match"]);
    expect(report.identical).toBe(true);
  });

  it("finds rows that exist only on the target, beyond the source's max key", async () => {
    await runAsAdmin(TARGET_ADMIN_URL, DB, `INSERT INTO currencies VALUES ('ZZZ', 'Test', 0)`);
    const report = await verifyData(source, target, { tables: ["currencies"], findRows: true });
    expect(report.tables[0]!.differingRows).toEqual([
      expect.objectContaining({ kind: "extra_in_target", key: { code: "ZZZ" } }),
    ]);
  });

  it("skips tables whose columns differ instead of guessing", async () => {
    await runAsAdmin(TARGET_ADMIN_URL, DB, `ALTER TABLE merchants ADD COLUMN note text`);
    const report = await verifyData(source, target, { tables: ["merchants"] });
    expect(report.tables[0]).toMatchObject({ status: "skipped" });
    expect(report.tables[0]!.reason).toMatch(/note/);
  });

  it("notes when row-level security limits which rows the role can see", async () => {
    const report = await verifyData(source, target, { tables: ["audit_log"] });
    expect(report.tables[0]!.notes?.join()).toMatch(/row-level security is on \(source, target\)/);
  });

  it("flags a sequence left behind its data, with the statement that fixes it", async () => {
    const before = await verifyData(source, target, { tables: ["transactions"] });
    expect(before.sequences).toEqual([expect.objectContaining({ table: "public.transactions", column: "id", status: "ok" })]);
    expect(before.sequencesOk).toBe(true);

    await runAsAdmin(TARGET_ADMIN_URL, DB, "SELECT setval('transactions_id_seq', 5)");
    const after = await verifyData(source, target, { tables: ["transactions"] });
    expect(after.sequencesOk).toBe(false);
    expect(after.sequences[0]).toMatchObject({
      status: "behind",
      nextValue: "6",
      fix: `SELECT setval('public.transactions_id_seq', (SELECT max("id") FROM "public"."transactions"));`,
    });
  });

  it("rejects a table that exists on neither side instead of reporting a difference", async () => {
    await expect(verifyData(source, target, { tables: ["transactionz"] })).rejects.toThrow("Unknown table(s), not found on source or target: public.transactionz");
  });
});

// Lag tolerance: `wait` runs between the first check and the recheck, so a test can
// play the part of replication catching up (or not) at exactly that moment.
describe("recheck (lag tolerance on a target still being replicated to)", () => {
  const toggleCards = (ids: number[]) => runAsAdmin(TARGET_ADMIN_URL, DB, `UPDATE cards SET is_active = NOT is_active WHERE id IN (${ids.join(", ")})`);
  const catchUp = (sql: () => Promise<unknown>) => async (ms: number) => {
    expect(ms).toBe(10);
    await sql();
  };

  it("doesn't report a difference that catches up before the recheck", async () => {
    await toggleCards([5]);
    const report = await verifyData(source, target, { tables: ["cards"], findRows: true, recheck: 2, recheckDelayMs: 10, wait: catchUp(() => toggleCards([5])) });
    const t = report.tables[0]!;
    expect(report.identical).toBe(true);
    expect(report.recheck).toEqual({ rounds: 1, delayMs: 10 }); // stops as soon as nothing is pending
    expect(t).toMatchObject({ status: "match", mismatchedChunks: [], differingRows: [], recheck: { settledRows: 1, settledChunks: 0, stillChanging: 0 } });
    expect(t.notes?.join()).toMatch(/1 row\(s\) that differed at first matched on a recheck/);
  });

  it("still reports a difference that never catches up, after every round", async () => {
    const report = await verifyData(source, target, { tables: ["transactions"], findRows: true, recheck: 2, recheckDelayMs: 10, wait: async () => {} });
    const t = report.tables[0]!;
    expect(report.identical).toBe(false);
    expect(report.recheck!.rounds).toBe(2);
    expect(t.status).toBe("mismatch");
    expect(t.mismatchedChunks).toHaveLength(1);
    expect(t.differingRows).toEqual([expect.objectContaining({ kind: "changed", key: { id: String(CHANGED_TX) } })]);
    expect(t.differingRows![0]!.sourceChanging).toBeUndefined(); // the source row is stable: the target is wrong
    expect(t.recheck).toEqual({ settledRows: 0, settledChunks: 0, stillChanging: 0 });
  });

  it("finds the same rows again by key: composite keys and char(n) text keys", async () => {
    // Both differences are permanent (made above), so a recheck must still see them.
    // If a key didn't round-trip, the row would look absent on both sides and wrongly "settle".
    const report = await verifyData(source, target, { tables: ["account_limits", "currencies"], findRows: true, recheck: 1, recheckDelayMs: 10, wait: async () => {} });
    expect(report.tables.map((t) => [t.status, t.recheck?.settledRows, t.differingRows?.map((r) => r.key)])).toEqual([
      ["mismatch", 0, [{ account_id: "777", limit_type: "atm_withdrawal" }]],
      ["mismatch", 0, [{ code: "ZZZ" }]],
    ]);
  });

  it("rechecks only the first check's differences, so new writes in the same range don't keep it failing", async () => {
    await toggleCards([5]);
    // During the wait, row 5 catches up and row 6 starts to differ (a new write in the same chunk).
    const report = await verifyData(source, target, { tables: ["cards"], recheck: 1, recheckDelayMs: 10, wait: catchUp(() => toggleCards([5, 6])) });
    expect(report.tables[0]).toMatchObject({ status: "match", recheck: { settledRows: 1 } });
    expect(report.tables[0]!.differingRows).toBeUndefined(); // rows were only listed with findRows
    await toggleCards([6]);
  });

  it("re-hashes a whole chunk when it had too many differences to list every row", async () => {
    await toggleCards([5, 6, 7]);
    const report = await verifyData(source, target, { tables: ["cards"], findRows: true, maxRows: 1, recheck: 1, recheckDelayMs: 10, wait: catchUp(() => toggleCards([5, 6, 7])) });
    expect(report.tables[0]).toMatchObject({ status: "match", recheck: { settledRows: 0, settledChunks: 1 } });
  });

  it("re-hashes a table without a primary key", async () => {
    const fx = (sign: string) => runAsAdmin(TARGET_ADMIN_URL, DB, `UPDATE fx_rates SET rate = rate ${sign} 0.000001 WHERE base = 'USD' AND quote = 'INR' AND as_of = '2024-03-01'`);
    const report = await verifyData(source, target, { tables: ["fx_rates"], recheck: 1, recheckDelayMs: 10, wait: catchUp(() => fx("-")) });
    expect(report.tables[0]).toMatchObject({ status: "match", localized: false, reason: undefined, recheck: { settledChunks: 1 } });
    expect(report.tables[0]!.notes?.join()).toMatch(/the table that differed at first matched on a recheck/);
    await fx("+"); // back to the difference made in beforeAll
  });

  it("is off by default: one check, no waiting", async () => {
    const report = await verifyData(source, target, { tables: ["transactions"], wait: () => Promise.reject(new Error("must not wait")) });
    expect(report.recheck).toBeUndefined();
    expect(report.tables[0]!.recheck).toBeUndefined();
  });
});
