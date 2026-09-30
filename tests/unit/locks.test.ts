import { describe, expect, it } from "vitest";
import { analyzeMigration } from "../../src/locks/analyze.js";
import { scoreRisk, sizeBucket } from "../../src/locks/risk.js";
import { col, schema, table } from "../helpers/schema.js";

// A schema with one big and one small table, so risk scoring has sizes to use.
const db = schema(
  table("transactions", [col("id", "bigint", { nullable: false }), col("amount", "numeric(12,2)"), col("note", "character varying(50)")], {
    estimatedRows: 1_000_000,
    primaryKey: ["id"],
  }),
  table("currencies", [col("code", "character(3)")], { estimatedRows: 5 }),
);

async function one(sql: string) {
  const r = await analyzeMigration(sql, db);
  return r.statements.at(-1)!;
}

describe("lock rule table (F5)", () => {
  it.each([
    ["SELECT * FROM transactions", "ACCESS SHARE", false, false],
    ["CREATE INDEX i ON transactions (amount)", "SHARE", false, true],
    ["CREATE INDEX CONCURRENTLY i ON transactions (amount)", "SHARE UPDATE EXCLUSIVE", false, false],
    ["ALTER TABLE transactions ADD COLUMN c int", "ACCESS EXCLUSIVE", true, true],
    ["ALTER TABLE transactions ALTER COLUMN amount TYPE numeric(16,2)", "ACCESS EXCLUSIVE", true, true],
    ["ALTER TABLE transactions ALTER COLUMN amount SET NOT NULL", "ACCESS EXCLUSIVE", true, true],
    ["ALTER TABLE transactions ADD CONSTRAINT c CHECK (amount > 0)", "ACCESS EXCLUSIVE", true, true],
    ["ALTER TABLE transactions ADD CONSTRAINT fk FOREIGN KEY (id) REFERENCES currencies (code)", "SHARE ROW EXCLUSIVE", false, true],
    ["ALTER TABLE transactions VALIDATE CONSTRAINT fk", "SHARE UPDATE EXCLUSIVE", false, false],
    ["ALTER TABLE transactions DROP COLUMN note", "ACCESS EXCLUSIVE", true, true],
    ["DROP TABLE transactions", "ACCESS EXCLUSIVE", true, true],
    ["VACUUM FULL transactions", "ACCESS EXCLUSIVE", true, true],
    ["CLUSTER transactions USING transactions_pkey", "ACCESS EXCLUSIVE", true, true],
    ["TRUNCATE transactions", "ACCESS EXCLUSIVE", true, true],
    ["UPDATE transactions SET amount = 0 WHERE id = 1", "ROW EXCLUSIVE", false, false],
  ])("%s -> %s", async (sql, mode, reads, writes) => {
    const s = await one(sql);
    expect(s.lockMode).toBe(mode);
    expect(s.blocksReads).toBe(reads);
    expect(s.blocksWrites).toBe(writes);
  });

  it("locks both tables for a foreign key", async () => {
    const s = await one("ALTER TABLE transactions ADD CONSTRAINT fk FOREIGN KEY (id) REFERENCES currencies (code)");
    expect(s.locks.map((l) => l.table)).toEqual(["public.transactions", "public.currencies"]);
  });

  it("knows constant defaults are instant but volatile defaults rewrite (PG 11+)", async () => {
    expect((await one("ALTER TABLE transactions ADD COLUMN c int NOT NULL DEFAULT 0")).rewritesTable).toBe(false);
    expect((await one("ALTER TABLE transactions ADD COLUMN c timestamptz DEFAULT now()")).rewritesTable).toBe(false);
    expect((await one("ALTER TABLE transactions ADD COLUMN c uuid DEFAULT gen_random_uuid()")).rewritesTable).toBe(true);
    expect((await one("ALTER TABLE transactions ADD COLUMN c bigserial")).rewritesTable).toBe(true);
  });

  it("knows growing a varchar is binary compatible but int -> bigint rewrites", async () => {
    expect((await one("ALTER TABLE transactions ALTER COLUMN note TYPE varchar(100)")).rewritesTable).toBe(false);
    expect((await one("ALTER TABLE transactions ALTER COLUMN note TYPE text")).rewritesTable).toBe(false);
    expect((await one("ALTER TABLE transactions ALTER COLUMN note TYPE varchar(10)")).rewritesTable).toBe(true);
    expect((await one("ALTER TABLE transactions ALTER COLUMN id TYPE numeric")).rewritesTable).toBe(true);
  });

  it("NOT VALID constraints skip the scan", async () => {
    expect((await one("ALTER TABLE transactions ADD CONSTRAINT c CHECK (amount > 0) NOT VALID")).scansTable).toBe(false);
    expect((await one("ALTER TABLE transactions ADD CONSTRAINT c CHECK (amount > 0)")).scansTable).toBe(true);
  });

  it("scores risk from the table size", async () => {
    expect((await one("CREATE INDEX i ON transactions (amount)")).risk).toBe("high"); // ~1M rows, blocks writes
    expect((await one("CREATE INDEX i ON currencies (code)")).risk).toBe("medium"); // tiny table
    expect((await one("CREATE INDEX CONCURRENTLY i ON transactions (amount)")).risk).toBe("low");
    expect((await one("DROP TABLE currencies")).risk).toBe("high"); // data loss
  });

  it("rewards SET lock_timeout on metadata-only changes", async () => {
    expect((await one("ALTER TABLE transactions ADD COLUMN c int")).risk).toBe("medium");
    expect((await one("SET lock_timeout = '3s'; ALTER TABLE transactions ADD COLUMN c int")).risk).toBe("low");
  });

  it("warns about missing lock_timeout and CONCURRENTLY inside a transaction", async () => {
    const r = await analyzeMigration("BEGIN; CREATE INDEX CONCURRENTLY i ON transactions (amount); COMMIT;", db);
    expect(r.warnings.join("\n")).toMatch(/cannot run inside a transaction block/);
    const r2 = await analyzeMigration("ALTER TABLE transactions ADD COLUMN c int;", db);
    expect(r2.warnings.join("\n")).toMatch(/No SET lock_timeout/);
  });

  it("combines multi-command ALTER TABLE into the strongest lock", async () => {
    const s = await one("ALTER TABLE transactions ADD COLUMN c int, ALTER COLUMN amount TYPE bigint");
    expect(s.lockMode).toBe("ACCESS EXCLUSIVE");
    expect(s.rewritesTable).toBe(true);
  });

  it("uses the schema to skip the SET NOT NULL scan when a validated IS NOT NULL check exists", async () => {
    const withCheck = structuredClone(db);
    withCheck.tables["public.transactions"]!.constraints.amount_nn = { name: "amount_nn", type: "check", definition: "CHECK ((amount IS NOT NULL))", validated: true };
    const r = await analyzeMigration("ALTER TABLE transactions ALTER COLUMN amount SET NOT NULL", withCheck);
    expect(r.statements[0]!.scansTable).toBe(false);
  });

  it("does not pretend unknown statements are safe", async () => {
    const s = await one("CREATE EXTENSION pg_trgm");
    expect(s.notes.join()).toMatch(/not in PgVouch's lock rule table/);
  });
});

describe("risk helpers", () => {
  it("buckets row estimates, treating -1 (never analyzed) as unknown", () => {
    expect([sizeBucket(-1), sizeBucket(50), sizeBucket(500_000), sizeBucket(50_000_000)]).toEqual(["unknown", "small", "medium", "large"]);
  });

  it("treats unknown-size heavy operations as high, not low", () => {
    expect(scoreRisk({ blocksReads: true, blocksWrites: true, heavy: true, dataLoss: false, estimatedRows: null, lockTimeoutSet: false }).risk).toBe("high");
  });
});
