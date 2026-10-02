import { describe, expect, it } from "vitest";
import { rewriteMigration } from "../../src/rewrite/rewrite.js";
import { ident, tableRef } from "../../src/sql/ident.js";
import { parseSql } from "../../src/sql/parse.js";

// Names that are Postgres keywords and realistic column or table names. Before, a hand-written
// list missed 53 of them, so plans and rewrites for such names were invalid SQL.
const KEYWORD_NAMES = ["case", "window", "current_date", "binary", "both", "verbose", "order", "user", "time", "values", "position", "json", "system_user", "analyze"];

describe("ident: names in generated SQL", () => {
  it("leaves plain lowercase names unquoted, so SQL reads like hand-written SQL", () => {
    expect(["transactions", "status", "merchant_id", "name", "type", "data"].map(ident)).toEqual(["transactions", "status", "merchant_id", "name", "type", "data"]);
  });

  it("quotes names that aren't plain lowercase, escaping quotes", () => {
    expect(ident("Order")).toBe('"Order"');
    expect(ident("Both Ways")).toBe('"Both Ways"');
    expect(ident('Order "Items" 2024')).toBe('"Order ""Items"" 2024"');
    expect(ident("a.b")).toBe('"a.b"');
  });

  it.each(KEYWORD_NAMES)("quotes the keyword %s, so the SQL parses", async (name) => {
    expect(ident(name)).toBe(`"${name}"`);
    await expect(parseSql(`ALTER TABLE ${ident(name)} ADD COLUMN ${ident(name)} int`)).resolves.toHaveLength(1);
    await expect(parseSql(`CREATE INDEX ${ident(name)} ON ${tableRef(`public.${name}`)} (${ident(name)})`)).resolves.toHaveLength(1);
  });

  it("produces a rewrite script that parses for a table and columns named after keywords", async () => {
    const sql = `ALTER TABLE "window" ADD COLUMN "both" uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE "window" ALTER COLUMN "binary" SET NOT NULL;`;
    const { script } = await rewriteMigration(sql); // no schema: offline
    expect(script).toContain('ALTER TABLE "window" ADD COLUMN "both" uuid');
    await expect(parseSql(script)).resolves.not.toHaveLength(0);
  });
});
