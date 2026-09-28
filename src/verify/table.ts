import type { Table } from "../introspect/types.js";
import { qualify, quoteIdent } from "../sql/ident.js";

/** Everything the checksum queries need to know about one table. */
export interface TableSpec {
  key: string; // "public.transactions"
  sql: string; // "public"."transactions" — safe to put in SQL text
  primaryKey: string[] | null;
  /** Columns hashed, in SOURCE order, so a different column order on target doesn't matter. */
  columns: string[];
}

/**
 * A primary-key range: lower bound inclusive, upper bound exclusive; null = unbounded.
 * Key values are kept as TEXT (e.g. "123", "2024-01-01 00:00:00+00") and cast back by
 * Postgres when used as parameters, so no precision is lost in JavaScript
 * (bigint > 2^53, timestamps with microseconds, numerics).
 */
export interface KeyRange {
  lower: string[] | null;
  upper: string[] | null;
}

export const FULL_RANGE: KeyRange = { lower: null, upper: null };

/**
 * Builds a TableSpec if the table can be compared column-for-column on both sides,
 * or returns the reason it can't. We don't guess across schema drift: fix drift first.
 */
export function buildTableSpec(source: Table, target: Table): TableSpec | { skip: string } {
  const sourceCols = Object.values(source.columns).sort((a, b) => a.position - b.position);
  const targetCols = target.columns;

  const differing = sourceCols.filter((c) => targetCols[c.name]?.type !== c.type).map((c) => c.name);
  const extra = Object.keys(targetCols).filter((name) => !source.columns[name]);
  if (differing.length > 0 || extra.length > 0) {
    return { skip: `columns differ between source and target (${[...differing, ...extra].join(", ")}); resolve schema drift first` };
  }
  if (JSON.stringify(source.primaryKey) !== JSON.stringify(target.primaryKey)) {
    return { skip: "primary keys differ between source and target; resolve schema drift first" };
  }

  return {
    key: `${source.schema}.${source.name}`,
    sql: qualify(source.schema, source.name),
    primaryKey: source.primaryKey,
    columns: sourceCols.map((c) => c.name),
  };
}

/** SQL fragments reused by the checksum and bisection queries. */
export function sqlParts(spec: TableSpec) {
  const pk = spec.primaryKey ?? [];
  const pkList = pk.map(quoteIdent).join(", ");
  return {
    pkList,
    // Single-column keys compare directly; composite keys use row comparison,
    // which Postgres evaluates lexicographically and can serve from the PK index.
    pkExpr: pk.length === 1 ? pkList : `(${pkList})`,
    pkAsText: pk.map((c, i) => `${quoteIdent(c)}::text AS k${i}`).join(", "),
    rowExpr: `ROW(${spec.columns.map(quoteIdent).join(", ")})`,
    // ARRAY[...] (not json_build_object) because it has no 100-argument limit.
    rowValues: `ARRAY[${spec.columns.map((c) => `${quoteIdent(c)}::text`).join(", ")}]`,
  };
}

/** WHERE clause + parameters for a key range. Parameters start at $1. */
export function rangeWhere(spec: TableSpec, range: KeyRange): { where: string; params: string[] } {
  const { pkExpr } = sqlParts(spec);
  const width = spec.primaryKey?.length ?? 0;
  const conditions: string[] = [];
  const params: string[] = [];

  const placeholder = (values: string[]) => {
    const refs = values.map((v) => {
      params.push(v);
      return `$${params.length}`;
    });
    return width === 1 ? refs[0]! : `(${refs.join(", ")})`;
  };

  if (range.lower) conditions.push(`${pkExpr} >= ${placeholder(range.lower)}`);
  if (range.upper) conditions.push(`${pkExpr} < ${placeholder(range.upper)}`);
  return { where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

export const describeRange = (r: KeyRange) =>
  `[${r.lower ? r.lower.join(",") : "-inf"}, ${r.upper ? r.upper.join(",") : "+inf"})`;
