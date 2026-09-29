import { describe, expect, it } from "vitest";
import { diffSchemas } from "../../src/diff/diff.js";
import { isWideningTypeChange } from "../../src/diff/typeChange.js";
import { clone, col, schema, table } from "../helpers/schema.js";

const accounts = table(
  "accounts",
  [col("id", "bigint", { nullable: false }), col("balance", "numeric(12,2)", { nullable: false }), col("status", "text", { default: "'active'::text" })],
  {
    primaryKey: ["id"],
    indexes: {
      accounts_pkey: { name: "accounts_pkey", definition: "CREATE UNIQUE INDEX accounts_pkey ON public.accounts USING btree (id)", unique: true, primary: true, valid: true },
      accounts_status_idx: { name: "accounts_status_idx", definition: "CREATE INDEX accounts_status_idx ON public.accounts USING btree (status)", unique: false, primary: false, valid: true },
    },
    constraints: {
      accounts_pkey: { name: "accounts_pkey", type: "primary_key", definition: "PRIMARY KEY (id)", validated: true },
      accounts_balance_check: { name: "accounts_balance_check", type: "check", definition: "CHECK ((balance >= (0)::numeric))", validated: true },
    },
  },
);
const source = schema(accounts);

describe("diffSchemas", () => {
  it("reports identical schemas as identical", () => {
    const report = diffSchemas(source, clone(source));
    expect(report).toEqual({ identical: true, summary: { high: 0, medium: 0, low: 0 }, items: [] });
  });

  it("detects missing and extra tables", () => {
    const target = schema(table("audit", [col("id", "bigint")]));
    const kinds = diffSchemas(source, target).items.map((i) => [i.kind, i.severity]);
    expect(kinds).toEqual([
      ["table_extra", "medium"],
      ["table_missing", "high"],
    ]);
  });

  it("detects a missing column as high severity", () => {
    const target = clone(source);
    delete target.tables["public.accounts"]!.columns.status;
    expect(diffSchemas(source, target).items).toContainEqual({
      kind: "column_missing", table: "public.accounts", column: "status", type: "text", severity: "high",
    });
  });

  it("rates an extra NOT NULL column without default as high (app inserts would fail)", () => {
    const target = clone(source);
    target.tables["public.accounts"]!.columns.risk = col("risk", "integer", { nullable: false });
    target.tables["public.accounts"]!.columns.note = col("note", "text");
    const items = diffSchemas(source, target).items.filter((i) => i.kind === "column_extra");
    expect(items.map((i) => [("column" in i && i.column), i.severity])).toEqual([
      ["note", "medium"],
      ["risk", "high"],
    ]);
  });

  it("rates widening type changes medium and narrowing high", () => {
    const widened = clone(source);
    widened.tables["public.accounts"]!.columns.balance!.type = "numeric(16,2)";
    const narrowed = clone(source);
    narrowed.tables["public.accounts"]!.columns.balance!.type = "numeric(10,2)";

    expect(diffSchemas(source, widened).items[0]).toMatchObject({ kind: "column_type_changed", severity: "medium" });
    expect(diffSchemas(source, narrowed).items[0]).toMatchObject({ kind: "column_type_changed", from: "numeric(12,2)", to: "numeric(10,2)", severity: "high" });
  });

  it("detects nullability and default changes", () => {
    const target = clone(source);
    target.tables["public.accounts"]!.columns.status!.nullable = false;
    target.tables["public.accounts"]!.columns.status!.default = "'pending'::text";
    expect(diffSchemas(source, target).items.map((i) => [i.kind, i.severity])).toEqual([
      ["column_default_changed", "medium"],
      ["column_nullability_changed", "high"],
    ]);
  });

  it("detects index missing, extra and changed (including partial predicates)", () => {
    const target = clone(source);
    const t = target.tables["public.accounts"]!;
    t.indexes.accounts_status_idx!.definition += " WHERE (status <> 'closed'::text)";
    t.indexes.accounts_new_idx = { name: "accounts_new_idx", definition: "CREATE INDEX accounts_new_idx ON public.accounts USING btree (balance)", unique: false, primary: false, valid: true };
    expect(diffSchemas(source, target).items.map((i) => i.kind)).toEqual(["index_changed", "index_extra"]);

    delete t.indexes.accounts_status_idx;
    expect(diffSchemas(source, target).items.map((i) => i.kind)).toContain("index_missing");
  });

  it("flags an INVALID index (failed CREATE INDEX CONCURRENTLY)", () => {
    const target = clone(source);
    target.tables["public.accounts"]!.indexes.accounts_status_idx!.valid = false;
    expect(diffSchemas(source, target).items).toEqual([
      expect.objectContaining({ kind: "index_changed", from: "VALID", to: "INVALID", severity: "medium" }),
    ]);
  });

  it("treats a NOT VALID-only constraint difference as medium, a different rule as high", () => {
    const notValid = clone(source);
    notValid.tables["public.accounts"]!.constraints.accounts_balance_check!.definition += " NOT VALID";
    expect(diffSchemas(source, notValid).items[0]).toMatchObject({ kind: "constraint_changed", severity: "medium" });

    const changed = clone(source);
    changed.tables["public.accounts"]!.constraints.accounts_balance_check!.definition = "CHECK ((balance >= ('-100'::integer)::numeric))";
    expect(diffSchemas(source, changed).items[0]).toMatchObject({ kind: "constraint_changed", severity: "high" });
  });

  it("detects missing constraints and primary key changes", () => {
    const target = clone(source);
    delete target.tables["public.accounts"]!.constraints.accounts_balance_check;
    target.tables["public.accounts"]!.primaryKey = ["id", "status"];
    expect(diffSchemas(source, target).items.map((i) => i.kind)).toEqual(["constraint_missing", "primary_key_changed"]);
  });

  it("suggests (but never assumes) a rename", () => {
    const target = clone(source);
    const t = target.tables["public.accounts"]!;
    t.columns.state = { ...t.columns.status!, name: "state" };
    delete t.columns.status;
    const report = diffSchemas(source, target);
    expect(report.items.map((i) => i.kind)).toEqual(["column_extra", "column_missing", "possible_rename"]);
    expect(report.identical).toBe(false);
  });

  it("detects sequence drift but ignores sequences' current values", () => {
    const s = { ...schema(), sequences: { "public.seq": { schema: "public", name: "seq", dataType: "bigint", increment: "1", minValue: "1", maxValue: "100", cycle: false } } };
    const t = clone(s);
    t.sequences["public.seq"]!.increment = "10";
    expect(diffSchemas(s, t).items).toEqual([
      { kind: "sequence_changed", sequence: "public.seq", field: "increment", from: "1", to: "10", severity: "low" },
    ]);
  });

  it("is deterministic regardless of key insertion order", () => {
    const a = schema(table("b", [col("x", "int")]), table("a", [col("y", "int")]));
    const b = schema(table("a", [col("y", "int")]), table("b", [col("x", "int")]));
    expect(diffSchemas(a, schema())).toEqual(diffSchemas(b, schema()));
  });
});

describe("isWideningTypeChange", () => {
  it.each([
    ["integer", "bigint", true],
    ["bigint", "integer", false],
    ["character varying(50)", "character varying(100)", true],
    ["character varying(100)", "character varying(50)", false],
    ["character varying(50)", "text", true],
    ["text", "character varying(50)", false],
    ["numeric(12,2)", "numeric(16,2)", true],
    ["numeric(12,2)", "numeric(12,4)", false], // scale change rounds values
    ["numeric(12,2)", "numeric", true],
    ["timestamp without time zone", "timestamp with time zone", false], // unknown => not widening
  ])("%s -> %s = %s", (from, to, expected) => {
    expect(isWideningTypeChange(from, to)).toBe(expected);
  });
});

describe("constraint-backed indexes", () => {
  it("reports a missing UNIQUE constraint once, not also as a missing index", () => {
    const s = schema(table("c", [col("email", "text")], {
      indexes: { c_email_key: { name: "c_email_key", definition: "CREATE UNIQUE INDEX c_email_key ON public.c USING btree (email)", unique: true, primary: false, valid: true } },
      constraints: { c_email_key: { name: "c_email_key", type: "unique", definition: "UNIQUE (email)", validated: true } },
    }));
    const t = clone(s);
    t.tables["public.c"]!.indexes = {};
    t.tables["public.c"]!.constraints = {};
    expect(diffSchemas(s, t).items.map((i) => i.kind)).toEqual(["constraint_missing"]);
  });
});
