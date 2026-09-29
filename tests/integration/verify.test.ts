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
});
