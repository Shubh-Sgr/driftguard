import { describe, expect, it } from "vitest";
import { analyzeMigration } from "../../src/locks/analyze.js";
import { RISK_ORDER } from "../../src/locks/risk.js";
import { rewriteMigration } from "../../src/rewrite/rewrite.js";
import { parseSql } from "../../src/sql/parse.js";
import { col, schema, table } from "../helpers/schema.js";

const db = schema(
  table("transactions", [col("id", "bigint", { nullable: false }), col("amount", "numeric(12,2)"), col("merchant_id", "integer"), col("note", "text")], {
    estimatedRows: 1_000_000,
    primaryKey: ["id"],
  }),
  table("accounts", [col("id", "bigint", { nullable: false })], { estimatedRows: 20_000, primaryKey: ["id"] }),
  table("fx_rates", [col("rate", "double precision")], { estimatedRows: 7_300 }),
);

const rewrite = (sql: string) => rewriteMigration(sql, { schema: db });

describe("safe-rewrite engine (F6)", () => {
  it("always starts the script with lock_timeout and statement_timeout", async () => {
    const { script } = await rewrite("CREATE INDEX i ON transactions (amount)");
    expect(script.split("\n").slice(2, 4)).toEqual(["SET lock_timeout = '3s';", "SET statement_timeout = '30min';"]);
  });

  it("CREATE INDEX -> CONCURRENTLY, marked non-transactional", async () => {
    const [s] = (await rewrite("CREATE UNIQUE INDEX i ON transactions (amount)")).statements;
    expect(s!.rule).toBe("create_index_concurrently");
    expect(s!.steps).toEqual([expect.objectContaining({ sql: "CREATE UNIQUE INDEX CONCURRENTLY i ON transactions (amount)", transactional: false })]);
  });

  it("FOREIGN KEY -> NOT VALID + VALIDATE, naming unnamed constraints", async () => {
    const [s] = (await rewrite("ALTER TABLE transactions ADD FOREIGN KEY (merchant_id) REFERENCES accounts (id) ON DELETE CASCADE")).statements;
    expect(s!.rule).toBe("foreign_key_not_valid");
    expect(s!.steps.map((x) => x.sql)).toEqual([
      "ALTER TABLE transactions ADD CONSTRAINT transactions_merchant_id_fkey FOREIGN KEY (merchant_id) REFERENCES accounts (id) ON DELETE CASCADE NOT VALID",
      "ALTER TABLE transactions VALIDATE CONSTRAINT transactions_merchant_id_fkey",
    ]);
  });

  it("CHECK -> NOT VALID + VALIDATE", async () => {
    const [s] = (await rewrite("ALTER TABLE transactions ADD CONSTRAINT positive CHECK (amount > 0)")).statements;
    expect(s!.steps.map((x) => x.sql)).toEqual([
      "ALTER TABLE transactions ADD CONSTRAINT positive CHECK (amount > 0) NOT VALID",
      "ALTER TABLE transactions VALIDATE CONSTRAINT positive",
    ]);
  });

  it("ADD COLUMN NOT NULL DEFAULT volatile() -> expand, backfill in batches, enforce via CHECK", async () => {
    const [s] = (await rewrite("ALTER TABLE transactions ADD COLUMN ref uuid NOT NULL DEFAULT gen_random_uuid()")).statements;
    expect(s!.rule).toBe("add_column_expand");
    const sqls = s!.steps.map((x) => x.sql);
    expect(sqls[0]).toBe("ALTER TABLE transactions ADD COLUMN ref uuid");
    expect(sqls[1]).toBe("ALTER TABLE transactions ALTER COLUMN ref SET DEFAULT gen_random_uuid()");
    expect(sqls[2]).toMatch(/UPDATE transactions SET ref = gen_random_uuid\(\) WHERE ref IS NULL AND id >= batch_start AND id < batch_start \+ 10000;\n\s+COMMIT;/);
    expect(sqls.slice(3)).toEqual([
      "ALTER TABLE transactions ADD CONSTRAINT transactions_ref_not_null CHECK (ref IS NOT NULL) NOT VALID",
      "ALTER TABLE transactions VALIDATE CONSTRAINT transactions_ref_not_null",
      "ALTER TABLE transactions ALTER COLUMN ref SET NOT NULL",
      "ALTER TABLE transactions DROP CONSTRAINT transactions_ref_not_null",
    ]);
  });

  it("leaves ADD COLUMN with a constant default alone (instant since PG 11)", async () => {
    const [s] = (await rewrite("ALTER TABLE transactions ADD COLUMN flag boolean NOT NULL DEFAULT false")).statements;
    expect(s!.rule).toBeNull();
  });

  it("asks a human for the backfill value of NOT NULL without DEFAULT", async () => {
    const [s] = (await rewrite("ALTER TABLE transactions ADD COLUMN region text NOT NULL")).statements;
    expect(s!.rule).toBe("add_column_expand");
    expect(s!.needsHumanInput).toBe(true);
  });

  it("falls back to a manual backfill when there's no single integer primary key", async () => {
    const [s] = (await rewrite("ALTER TABLE fx_rates ADD COLUMN src text NOT NULL DEFAULT md5(random()::text)")).statements;
    expect(s!.steps.find((x) => x.kind === "manual")?.sql).toMatch(/MANUAL: backfill in batches/);
  });

  it("SET NOT NULL -> CHECK NOT VALID, VALIDATE, SET NOT NULL, DROP CHECK", async () => {
    const [s] = (await rewrite("ALTER TABLE transactions ALTER COLUMN note SET NOT NULL")).statements;
    expect(s!.rule).toBe("set_not_null_via_check");
    expect(s!.steps).toHaveLength(4);
  });

  it("ALTER COLUMN TYPE with a rewrite -> expand/contract with manual deploy steps", async () => {
    const [s] = (await rewrite("ALTER TABLE transactions ALTER COLUMN merchant_id TYPE bigint")).statements;
    expect(s!.rule).toBe("alter_type_expand_contract");
    expect(s!.steps.filter((x) => x.kind === "manual")).toHaveLength(4);
  });

  it("keeps the old column's DEFAULT and NOT NULL on the new column (regression found by shadow runs)", async () => {
    const withBalance = structuredClone(db);
    withBalance.tables["public.transactions"]!.columns.amount = col("amount", "numeric(12,2)", { nullable: false, default: "0" });
    const [s] = (await rewriteMigration("ALTER TABLE transactions ALTER COLUMN amount TYPE numeric(10,2)", { schema: withBalance })).statements;
    const sqls = s!.steps.map((x) => x.sql);
    expect(sqls).toContain("ALTER TABLE transactions ALTER COLUMN amount_new SET DEFAULT 0");
    expect(sqls).toContain("ALTER TABLE transactions ALTER COLUMN amount_new SET NOT NULL");
    expect(sqls.find((x) => x.includes("RENAME COLUMN amount TO amount_old"))).toContain("ALTER COLUMN amount_old DROP NOT NULL");
  });

  it("leaves binary-compatible type changes alone", async () => {
    const [s] = (await rewrite("ALTER TABLE transactions ALTER COLUMN amount TYPE numeric(16,2)")).statements;
    expect(s!.rule).toBeNull();
  });

  it("UNIQUE -> CREATE UNIQUE INDEX CONCURRENTLY + USING INDEX", async () => {
    const [s] = (await rewrite("ALTER TABLE transactions ADD CONSTRAINT u UNIQUE (note)")).statements;
    expect(s!.steps.map((x) => x.sql)).toEqual([
      "CREATE UNIQUE INDEX CONCURRENTLY u ON transactions (note)",
      "ALTER TABLE transactions ADD CONSTRAINT u UNIQUE USING INDEX u",
    ]);
  });

  it("splits DROP INDEX of several indexes into one CONCURRENTLY statement each", async () => {
    const [s] = (await rewrite("DROP INDEX IF EXISTS a, b")).statements;
    expect(s!.steps.map((x) => x.sql)).toEqual(["DROP INDEX CONCURRENTLY IF EXISTS a", "DROP INDEX CONCURRENTLY IF EXISTS b"]);
  });

  it("batches a WHERE-less UPDATE", async () => {
    const [s] = (await rewrite("UPDATE transactions SET note = upper(note)")).statements;
    expect(s!.steps[0]!.sql).toContain("UPDATE transactions SET note = upper(note) WHERE id >= batch_start");
  });

  it("does not 'fix' data-lossy statements — it explains them", async () => {
    const [s] = (await rewrite("ALTER TABLE transactions DROP COLUMN note")).statements;
    expect(s!.rule).toBeNull();
    expect(s!.explanation).toMatch(/permanently removes data/);
  });

  it("drops the user's own SET lock_timeout/BEGIN/COMMIT (the script decides those)", async () => {
    const r = await rewrite("SET lock_timeout = 0; BEGIN; CREATE INDEX i ON transactions (amount); COMMIT;");
    expect(r.statements).toHaveLength(1);
  });

  // The property that matters most: every generated step is valid SQL, and none of
  // them is riskier than the statement it replaces.
  it.each([
    "CREATE INDEX i ON transactions (amount)",
    "ALTER TABLE transactions ADD CONSTRAINT fk FOREIGN KEY (merchant_id) REFERENCES accounts (id)",
    "ALTER TABLE transactions ADD CONSTRAINT c CHECK (amount > 0)",
    "ALTER TABLE transactions ADD COLUMN r uuid NOT NULL DEFAULT gen_random_uuid()",
    "ALTER TABLE transactions ALTER COLUMN note SET NOT NULL",
    "ALTER TABLE transactions ADD CONSTRAINT u UNIQUE (note)",
    "ALTER TABLE transactions ALTER COLUMN merchant_id TYPE bigint",
  ])("steps for %s parse and are lower risk", async (sql) => {
    const r = await rewrite(sql);
    const before = r.statements[0]!.analysis.risk;
    const steps = r.statements[0]!.steps.filter((s) => s.kind !== "manual");
    for (const step of steps) await expect(parseSql(step.sql)).resolves.toBeDefined();
    // Analyze the steps together, in order, as the generated script runs them
    // (after SET lock_timeout), so later steps see what earlier steps set up.
    const after = await analyzeMigration(`SET lock_timeout = '3s';\n${steps.map((s) => `${s.sql};`).join("\n")}`, db);
    for (const st of after.statements) {
      expect(RISK_ORDER.indexOf(st.risk)).toBeLessThan(Math.max(RISK_ORDER.indexOf(before), 1));
    }
  });
});
