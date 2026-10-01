import { describe, expect, it } from "vitest";
import { buildTableSpec, rangeWhere, sqlParts, type TableSpec } from "../../src/verify/table.js";
import { col, table } from "../helpers/schema.js";

const spec = (t: ReturnType<typeof table>) => buildTableSpec(t, t) as TableSpec;

describe("key ordering is the same on every server (collation)", () => {
  it("orders and compares text-like keys byte-wise (COLLATE \"C\")", () => {
    const s = spec(table("currencies", [col("code", "character(3)", { nullable: false }), col("name", "text")], { primaryKey: ["code"] }));
    expect(s.textKeys).toEqual(["code"]);
    expect(sqlParts(s).pkOrder).toBe('"code" COLLATE "C"');
    expect(rangeWhere(s, { lower: ["GBP"], upper: ["USD"] }).where).toBe('WHERE "code" COLLATE "C" >= $1 AND "code" COLLATE "C" < $2');
  });

  it("applies it per column in a composite key", () => {
    const s = spec(table("limits", [col("account_id", "bigint", { nullable: false }), col("limit_type", "text", { nullable: false })], { primaryKey: ["account_id", "limit_type"] }));
    expect(s.textKeys).toEqual(["limit_type"]);
    expect(sqlParts(s).pkExpr).toBe('("account_id", "limit_type" COLLATE "C")');
  });

  it.each(["bigint", "integer", "uuid", "timestamp with time zone", "numeric(12,2)"])("leaves %s keys alone (they keep using the index)", (type) => {
    const s = spec(table("t", [col("id", type, { nullable: false })], { primaryKey: ["id"] }));
    expect(s.textKeys).toEqual([]);
    expect(sqlParts(s).pkOrder).toBe('"id"');
  });

  it.each(["text", "character varying(50)", "character varying", "citext", "text[]"])("treats %s as text-like", (type) => {
    const s = spec(table("t", [col("k", type, { nullable: false })], { primaryKey: ["k"] }));
    expect(s.textKeys).toEqual(["k"]);
  });
});
