import type { AstNode } from "./parse.js";

// Parser type names are internal ("int4", "varchar"). We convert them to the names
// format_type() prints ("integer", "character varying(50)"), so a type written in a
// migration can be compared directly with an introspected column type.
const INTERNAL_TO_DISPLAY: Record<string, string> = {
  int2: "smallint",
  int4: "integer",
  int8: "bigint",
  float4: "real",
  float8: "double precision",
  bool: "boolean",
  varchar: "character varying",
  bpchar: "character",
  timestamptz: "timestamp with time zone",
  timestamp: "timestamp without time zone",
  timetz: "time with time zone",
  time: "time without time zone",
  int: "integer",
};

/** Renders a TypeName AST node as SQL, e.g. "numeric(16,2)", "text[]". */
export function formatTypeName(typeName: AstNode): string {
  const names: string[] = (typeName.names ?? []).map((n: AstNode) => n.String.sval);
  // Built-in types come back as ["pg_catalog", "int4"]; drop the schema.
  const parts = names[0] === "pg_catalog" ? names.slice(1) : names;
  const base = parts.length === 1 ? (INTERNAL_TO_DISPLAY[parts[0]!] ?? parts[0]!) : parts.join(".");
  // An omitted integer in the AST means 0 (protobuf leaves out default values).
  const mods: number[] = (typeName.typmods ?? []).map((m: AstNode) => m.A_Const?.ival?.ival ?? 0);
  const array = "[]".repeat(typeName.arrayBounds?.length ?? 0);
  return `${base}${mods.length ? `(${mods.join(",")})` : ""}${array}`;
}

/** serial types are shorthand for integer + a sequence default (nextval, which is volatile). */
export const SERIAL_TYPES = new Set(["serial", "serial4", "bigserial", "serial8", "smallserial", "serial2"]);

// Functions whose value differs per row. A DEFAULT using one of these forces
// ADD COLUMN to rewrite the whole table (each existing row needs its own value).
// Stable functions like now() are evaluated once, so they don't force a rewrite.
const VOLATILE_FUNCTIONS = new Set([
  "random",
  "gen_random_uuid",
  "uuid_generate_v4",
  "uuid_generate_v1",
  "clock_timestamp",
  "timeofday",
  "nextval",
  "txid_current",
]);

/** True if the expression tree calls a known volatile function anywhere. */
export function callsVolatileFunction(expr: AstNode): boolean {
  if (expr === null || typeof expr !== "object") return false;
  if (expr.FuncCall) {
    const name = expr.FuncCall.funcname?.at(-1)?.String?.sval;
    if (VOLATILE_FUNCTIONS.has(name)) return true;
  }
  return Object.values(expr).some(callsVolatileFunction);
}

/**
 * True if changing a column from `from` to `to` is "binary coercible" — Postgres
 * only updates the catalog and does NOT rewrite the table (e.g. growing a varchar).
 * int -> bigint is NOT on this list: the on-disk size changes, so it rewrites.
 */
export function isBinaryCompatibleChange(from: string, to: string): boolean {
  if (from === to) return true;
  const vc = /^character varying(?:\((\d+)\))?$/;
  const num = /^numeric(?:\((\d+),(\d+)\))?$/;
  const f = vc.exec(from);
  if (f) {
    if (to === "text") return true;
    const t = vc.exec(to);
    return !!t && (t[1] === undefined || (f[1] !== undefined && Number(t[1]) >= Number(f[1])));
  }
  if (from === "text" && to === "character varying") return true;
  const nf = num.exec(from);
  const nt = num.exec(to);
  if (nf && nt) {
    if (nt[1] === undefined) return true;
    return nf[1] !== undefined && Number(nt[1]) >= Number(nf[1]) && nt[2] === nf[2];
  }
  return false;
}
