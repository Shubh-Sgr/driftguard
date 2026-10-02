import { describe, expect, it } from "vitest";
import { classifyReversibility } from "../../src/reversibility/classify.js";
import { parseSql } from "../../src/sql/parse.js";
import { col, schema, table } from "../helpers/schema.js";

const before = schema(
  table("accounts", [col("id", "bigint"), col("status", "text", { default: "'active'::text" }), col("balance", "numeric(12,2)")], {
    indexes: { accounts_status_idx: { name: "accounts_status_idx", definition: "CREATE INDEX accounts_status_idx ON public.accounts USING btree (status)", unique: false, primary: false, valid: true } },
    constraints: { positive: { name: "positive", type: "check", definition: "CHECK ((balance >= (0)::numeric))", validated: true } },
  }),
);

async function classify(sql: string) {
  const [stmt] = await parseSql(sql);
  return classifyReversibility(stmt!, before);
}

describe("reversibility classifier (F11)", () => {
  it.each([
    ["CREATE INDEX i ON accounts (balance)", "reversible", "DROP INDEX CONCURRENTLY IF EXISTS i"],
    ["ALTER TABLE accounts ADD COLUMN note text", "reversible", "ALTER TABLE accounts DROP COLUMN note"],
    ["ALTER TABLE accounts ALTER COLUMN balance TYPE numeric(16,2)", "reversible-with-backfill", "ALTER TABLE accounts ALTER COLUMN balance TYPE numeric(12,2)"],
    ["ALTER TABLE accounts ALTER COLUMN status SET DEFAULT 'x'", "reversible", "ALTER TABLE accounts ALTER COLUMN status SET DEFAULT 'active'::text"],
    ["ALTER TABLE accounts DROP CONSTRAINT positive", "reversible", "ALTER TABLE accounts ADD CONSTRAINT positive CHECK ((balance >= (0)::numeric))"],
    ["DROP INDEX accounts_status_idx", "reversible", "CREATE INDEX CONCURRENTLY accounts_status_idx ON public.accounts USING btree (status)"],
    ["ALTER TABLE accounts RENAME COLUMN status TO state", "reversible", "ALTER TABLE accounts RENAME COLUMN state TO status"],
    ["ALTER TABLE accounts DROP COLUMN status", "data-lossy", null],
    ["DROP TABLE accounts", "data-lossy", null],
    ["TRUNCATE accounts", "data-lossy", null],
    ["CREATE TRIGGER t1 BEFORE INSERT ON accounts FOR EACH ROW EXECUTE FUNCTION f()", "reversible", "DROP TRIGGER t1 ON accounts"],
    ["CREATE POLICY p ON accounts FOR SELECT USING (true)", "reversible", "DROP POLICY p ON accounts"],
    ["CREATE OR REPLACE VIEW new_view AS SELECT 1", "reversible", "DROP VIEW new_view"],
    ["ALTER TABLE accounts DISABLE TRIGGER t1", "reversible", "ALTER TABLE accounts ENABLE TRIGGER t1"],
    ["ALTER TABLE accounts ENABLE ROW LEVEL SECURITY", "reversible", "ALTER TABLE accounts DISABLE ROW LEVEL SECURITY"],
    ["ALTER TYPE s ADD VALUE 'x'", "unknown", null],
  ])("%s -> %s", async (sql, reversibility, rollbackSql) => {
    expect(await classify(sql)).toMatchObject({ reversibility, rollbackSql });
  });

  it("multi-command ALTER: worst class wins, rollbacks run in reverse order", async () => {
    const res = await classify("ALTER TABLE accounts ADD COLUMN a int, ADD COLUMN b int");
    expect(res.rollbackSql).toBe("ALTER TABLE accounts DROP COLUMN b;\nALTER TABLE accounts DROP COLUMN a");
    expect((await classify("ALTER TABLE accounts ADD COLUMN a int, DROP COLUMN status")).reversibility).toBe("data-lossy");
  });
});
