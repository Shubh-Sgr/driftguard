import type pg from "pg";
import { hashRange, type RangeHash } from "./checksum.js";
import { rangeWhere, sqlParts, type KeyRange, type TableSpec } from "./table.js";

export type RowDiff = (
  | { kind: "missing_in_target"; key: Record<string, string>; source: Record<string, string | null> }
  | { kind: "extra_in_target"; key: Record<string, string>; target: Record<string, string | null> }
  | {
      kind: "changed";
      key: Record<string, string>;
      columns: string[];
      source: Record<string, string | null>;
      target: Record<string, string | null>;
    }
) & {
  /** Set by a recheck: the source row itself changed between checks, so it may be in flight rather than wrong. */
  sourceChanging?: boolean;
};

export interface BisectStats {
  /** Hash queries issued (each one runs on BOTH databases). */
  hashQueries: number;
  /** Rows actually fetched, summed over both databases. */
  rowsFetched: number;
  /** Deepest level of halving reached. */
  maxDepth: number;
}

export interface BisectResult {
  rows: RowDiff[];
  stats: BisectStats;
  /** True if we stopped at maxRows: the mismatch is widespread; the list is partial. */
  truncated: boolean;
}

export interface BisectOptions {
  /** Stop halving when a range has at most this many rows on each side. */
  leafSize?: number;
  /** Stop after this many differing rows ("widespread mismatch"). */
  maxRows?: number;
}

/**
 * Finds the exact differing rows in a range whose hashes already disagree.
 *
 * Binary search over the key space (the Merkle-tree idea): split the range at its
 * median key, hash both halves on both sides, and descend only into halves whose
 * hashes differ. One bad row in N rows costs about log2(N / leafSize) rounds of
 * hash queries, then one small fetch of at most leafSize rows per side.
 */
export async function findDifferingRows(
  source: pg.PoolClient,
  target: pg.PoolClient,
  spec: TableSpec,
  range: KeyRange,
  known: { source: RangeHash; target: RangeHash },
  opts: BisectOptions = {},
): Promise<BisectResult> {
  if (!spec.primaryKey) throw new Error(`${spec.key} has no primary key; differing rows cannot be localized`);
  const leafSize = opts.leafSize ?? 50;
  const maxRows = opts.maxRows ?? 1000;

  const result: BisectResult = { rows: [], stats: { hashQueries: 0, rowsFetched: 0, maxDepth: 0 }, truncated: false };

  async function visit(r: KeyRange, s: RangeHash, t: RangeHash, depth: number): Promise<void> {
    if (result.rows.length >= maxRows) {
      result.truncated = true;
      return;
    }
    result.stats.maxDepth = Math.max(result.stats.maxDepth, depth);

    // Small enough: fetch the rows from both sides and compare them directly.
    if (Math.max(s.rows, t.rows) <= leafSize) {
      const diffs = await diffRowsInRange(source, target, spec, r, result.stats);
      for (const d of diffs) {
        if (result.rows.length >= maxRows) {
          result.truncated = true;
          break;
        }
        result.rows.push(d);
      }
      return;
    }

    // Split at the median key of whichever side has more rows in this range.
    const mid = await medianKey(s.rows >= t.rows ? source : target, spec, r, Math.max(s.rows, t.rows));
    const halves: KeyRange[] = [
      { lower: r.lower, upper: mid },
      { lower: mid, upper: r.upper },
    ];

    for (const half of halves) {
      const [hs, ht] = await Promise.all([hashRange(source, spec, half), hashRange(target, spec, half)]);
      result.stats.hashQueries++;
      if (hs.hash !== ht.hash) await visit(half, hs, ht, depth + 1);
    }
  }

  await visit(range, known.source, known.target, 0);
  return result;
}

/** The key at position floor(count/2) inside the range, via the PK index. */
async function medianKey(client: pg.PoolClient, spec: TableSpec, range: KeyRange, count: number): Promise<string[]> {
  const { pkOrder, pkAsText } = sqlParts(spec);
  const { where, params } = rangeWhere(spec, range);
  params.push(String(Math.floor(count / 2)));
  const { rows } = await client.query(
    `SELECT ${pkAsText} FROM ${spec.sql} ${where} ORDER BY ${pkOrder} OFFSET $${params.length} LIMIT 1`,
    params,
  );
  // The offset is < count, so a row always exists within the same snapshot.
  return spec.primaryKey!.map((_, i) => rows[0]![`k${i}`] as string);
}

/** Fetches a (small) range from both sides and compares rows column by column. */
async function diffRowsInRange(
  source: pg.PoolClient,
  target: pg.PoolClient,
  spec: TableSpec,
  range: KeyRange,
  stats: BisectStats,
): Promise<RowDiff[]> {
  const [sRows, tRows] = await Promise.all([fetchRows(source, spec, range), fetchRows(target, spec, range)]);
  stats.rowsFetched += sRows.size + tRows.size;
  return compareRows(spec, sRows, tRows);
}

/** Compares fetched rows column by column. Rows that are equal on both sides are left out. */
export function compareRows(spec: TableSpec, sRows: Map<string, FetchedRow>, tRows: Map<string, FetchedRow>): RowDiff[] {
  const diffs: RowDiff[] = [];
  // A key may exist on only one side, so walk the union: source keys in PK order,
  // then keys that exist only on the target.
  const allKeys = [...new Set([...sRows.keys(), ...tRows.keys()])];
  for (const k of allKeys) {
    const s = sRows.get(k);
    const t = tRows.get(k);
    if (s && !t) diffs.push({ kind: "missing_in_target", key: s.key, source: s.values });
    else if (!s && t) diffs.push({ kind: "extra_in_target", key: t.key, target: t.values });
    else if (s && t) {
      const columns = spec.columns.filter((c) => s.values[c] !== t.values[c]);
      // Hashes differed for the range, but individual rows may still be equal.
      if (columns.length > 0) diffs.push({ kind: "changed", key: s.key, columns, source: s.values, target: t.values });
    }
  }
  return diffs;
}

export interface FetchedRow {
  key: Record<string, string>;
  values: Record<string, string | null>;
}

async function fetchRows(client: pg.PoolClient, spec: TableSpec, range: KeyRange): Promise<Map<string, FetchedRow>> {
  const { pkOrder, pkAsText, rowValues } = sqlParts(spec);
  const { where, params } = rangeWhere(spec, range);
  const { rows } = await client.query(
    `SELECT ${pkAsText}, ${rowValues} AS v FROM ${spec.sql} ${where} ORDER BY ${pkOrder}`,
    params,
  );
  return toFetchedRows(spec, rows);
}

/**
 * Fetches exactly these keys (the rows a recheck looks at again), in batches. Keys are
 * matched with the same per-column expressions as every other key comparison
 * (byte-wise for text keys), so a key found before is found again.
 */
export async function fetchRowsByKeys(client: pg.PoolClient, spec: TableSpec, keys: Record<string, string>[]): Promise<Map<string, FetchedRow>> {
  const { pkOrder, pkExpr, pkAsText, rowValues } = sqlParts(spec);
  const pk = spec.primaryKey!;
  const out = new Map<string, FetchedRow>();
  for (let i = 0; i < keys.length; i += KEY_BATCH) {
    const params: string[] = [];
    const tuples = keys.slice(i, i + KEY_BATCH).map((key) => {
      const refs = pk.map((c) => {
        params.push(key[c]!);
        return `$${params.length}`;
      });
      return pk.length === 1 ? refs[0]! : `(${refs.join(", ")})`;
    });
    const { rows } = await client.query(
      `SELECT ${pkAsText}, ${rowValues} AS v FROM ${spec.sql} WHERE ${pkExpr} IN (${tuples.join(", ")}) ORDER BY ${pkOrder}`,
      params,
    );
    for (const [k, row] of toFetchedRows(spec, rows)) out.set(k, row);
  }
  return out;
}

const KEY_BATCH = 500;

/** The id a row is matched by on both sides: its key values in PK order. */
export const rowKeyId = (key: Record<string, string>) => Object.values(key).join("\u0000");

function toFetchedRows(spec: TableSpec, rows: Record<string, unknown>[]): Map<string, FetchedRow> {
  const pk = spec.primaryKey!;
  const out = new Map<string, FetchedRow>();
  for (const r of rows) {
    const key = Object.fromEntries(pk.map((c, i) => [c, r[`k${i}`] as string]));
    const values = Object.fromEntries(spec.columns.map((c, i) => [c, (r.v as (string | null)[])[i] ?? null]));
    // \u0000 can't appear in Postgres text, so it's a safe separator for composite keys.
    out.set(rowKeyId(key), { key, values });
  }
  return out;
}
