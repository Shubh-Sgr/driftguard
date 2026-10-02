import type pg from "pg";
import { rangeWhere, sqlParts, type KeyRange, type TableSpec } from "./table.js";

export interface RangeHash {
  rows: number;
  hash: string;
}

/**
 * Hashes every row in a key range, entirely inside Postgres. Only a count and a
 * 32-character hash come back over the network.
 *
 * md5() per row, then md5 over the concatenation: the aggregate grows by 32 bytes per
 * row instead of by the full row width, so a 10k-row chunk builds ~320 KB in the
 * server's memory no matter how wide the table is.
 *
 * ORDER BY the primary key inside string_agg makes the order (and so the hash)
 * deterministic; without it, identical data could hash differently.
 */
export async function hashRange(client: pg.PoolClient, spec: TableSpec, range: KeyRange): Promise<RangeHash> {
  const { pkOrder, rowExpr } = sqlParts(spec);
  const { where, params } = rangeWhere(spec, range);
  const { rows } = await client.query<{ n: string; hash: string }>(
    `SELECT count(*) AS n,
            coalesce(md5(string_agg(md5(${rowExpr}::text), '' ORDER BY ${pkOrder})), '') AS hash
     FROM ${spec.sql} ${where}`,
    params,
  );
  return { rows: Number(rows[0]!.n), hash: rows[0]!.hash };
}

/**
 * Whole-table hash for tables WITHOUT a primary key. There is no stable order, so we
 * sort by each row's own hash: that treats the table as a multiset, which is still
 * deterministic. It can say THAT the tables differ but not WHERE ("cannot localize").
 */
export async function hashWholeTable(client: pg.PoolClient, spec: TableSpec): Promise<RangeHash> {
  const { rowExpr } = sqlParts(spec);
  const { rows } = await client.query<{ n: string; hash: string }>(
    `SELECT count(*) AS n, coalesce(md5(string_agg(h, '' ORDER BY h COLLATE "C")), '') AS hash
     FROM (SELECT md5(${rowExpr}::text) AS h FROM ${spec.sql}) AS row_hashes`,
  );
  return { rows: Number(rows[0]!.n), hash: rows[0]!.hash };
}

/**
 * Chunk boundaries taken from real keys on the source: every `chunkSize`-th key.
 * Using actual keys (not arithmetic ranges like 0..10000) keeps chunks equal-sized
 * even when ids are sparse or not numeric at all (uuid, text, composite keys).
 *
 * Returns chunks covering the WHOLE key space: the first chunk has no lower bound and
 * the last has no upper bound, so rows that exist only on the target (below the
 * source's min key or above its max) still fall into some chunk.
 */
export async function chunkRanges(client: pg.PoolClient, spec: TableSpec, chunkSize: number): Promise<KeyRange[]> {
  const { pkList, pkOrder, pkAsText } = sqlParts(spec);
  const width = spec.primaryKey!.length;
  const { rows } = await client.query(
    `SELECT ${pkAsText}
     FROM (SELECT ${pkList}, row_number() OVER (ORDER BY ${pkOrder}) AS rn FROM ${spec.sql}) AS numbered
     WHERE rn % $1 = 1 AND rn > 1
     ORDER BY rn`,
    [chunkSize],
  );
  const boundaries = rows.map((r) => Array.from({ length: width }, (_, i) => r[`k${i}`] as string));

  const ranges: KeyRange[] = [];
  let lower: string[] | null = null;
  for (const b of boundaries) {
    ranges.push({ lower, upper: b });
    lower = b;
  }
  ranges.push({ lower, upper: null });
  return ranges;
}
