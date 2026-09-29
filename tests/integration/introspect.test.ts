import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db.js";
import { diffSchemas } from "../../src/diff/diff.js";
import { introspect } from "../../src/introspect/introspect.js";
import { createScratchDatabase, dropScratchDatabase, runAsAdmin, withDatabase } from "../../evals/lib/scratch.js";
import { SEED_TRANSACTIONS, SOURCE_RO_URL, TARGET_ADMIN_URL, TARGET_RO_URL } from "./env.js";

const DB = "dg_test_introspect";
let source: pg.Pool;
let target: pg.Pool;

beforeAll(async () => {
  await createScratchDatabase(TARGET_ADMIN_URL, DB);
  await runAsAdmin(TARGET_ADMIN_URL, DB, `
    ALTER TABLE accounts ALTER COLUMN balance TYPE numeric(16,2);
    DROP INDEX transactions_pending_idx;
    CREATE INDEX transactions_pending_idx ON transactions (created_at) WHERE status IN ('pending', 'reversed');
    ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_transaction_id_fkey;
    ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_transaction_id_fkey
      FOREIGN KEY (transaction_id) REFERENCES transactions (id) NOT VALID;
  `);
  source = createPool(SOURCE_RO_URL, { statementTimeoutMs: 30_000 });
  target = createPool(withDatabase(TARGET_RO_URL, DB), { statementTimeoutMs: 30_000 });
});

afterAll(async () => {
  await Promise.all([source?.end(), target?.end()]);
  await dropScratchDatabase(TARGET_ADMIN_URL, DB);
});

describe("introspect (F1)", () => {
  it("reads the seeded schema with exact types, keys and partial indexes", async () => {
    const s = await introspect(source);
    expect(Object.keys(s.tables)).toHaveLength(10);
    const tx = s.tables["public.transactions"]!;
    expect(tx.columns.amount).toMatchObject({ type: "numeric(12,2)", nullable: false });
    expect(tx.columns.id!.identity).toBe("by default");
    expect(tx.primaryKey).toEqual(["id"]);
    expect(tx.indexes.transactions_pending_idx!.definition).toMatch(/WHERE \(status = 'pending'::text\)$/);
    expect(tx.estimatedRows).toBeGreaterThan(0.9 * SEED_TRANSACTIONS);
    expect(s.tables["public.account_limits"]!.primaryKey).toEqual(["account_id", "limit_type"]);
    expect(s.tables["public.fx_rates"]!.primaryKey).toBeNull();
    expect(s.sequences["public.invoice_number_seq"]).toBeDefined();
  });
});

describe("introspect + diff (F1 + F2) against real drift", () => {
  it("reports no drift between the two identical seeds", async () => {
    const targetMain = createPool(TARGET_RO_URL, { statementTimeoutMs: 30_000 });
    try {
      expect(diffSchemas(await introspect(source), await introspect(targetMain)).identical).toBe(true);
    } finally {
      await targetMain.end();
    }
  });

  it("finds exactly the drift created in the scratch target", async () => {
    const report = diffSchemas(await introspect(source), await introspect(target));
    expect(report.items.map((i) => [i.kind, i.severity])).toEqual([
      ["column_type_changed", "medium"], // widening numeric(12,2) -> numeric(16,2)
      ["constraint_changed", "medium"], // only NOT VALID differs
      ["index_changed", "low"], // partial-index predicate changed
    ]);
  });
});
