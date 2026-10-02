import type pg from "pg";
import { compareRows, fetchRowsByKeys, rowKeyId, type RowDiff } from "./bisect.js";
import { hashRange, hashWholeTable } from "./checksum.js";
import type { TableSpec } from "./table.js";
import type { MismatchedChunk } from "./verify.js";

/**
 * Lag tolerance. On a target that is still being replicated to, rows written a moment
 * ago on the source differ on the target only because they are in flight. A recheck
 * looks at the SAME differences again after a delay, in a new snapshot, and drops the
 * ones that caught up. What remains differed every time it was looked at.
 *
 * Only differences seen in the first check are rechecked. Rows written after it are
 * not part of the comparison, so a busy table can still settle.
 */

/** One mismatched chunk waiting for a recheck. */
export interface PendingChunk {
  chunk: MismatchedChunk;
  /**
   * Every differing row in the chunk, rechecked one by one. Null when the chunk has no
   * complete row list (bisection stopped at --max-rows): then the whole chunk is
   * re-hashed, and new writes inside its key range can keep it differing.
   */
  rows: RowDiff[] | null;
  /** Rows found before bisection stopped (shown in the report when rows is null). */
  partialRows: RowDiff[];
}

/** The rechecks of one mismatched table. */
export interface PendingTable {
  spec: TableSpec;
  /** A table without a primary key that differs: only its whole-table hash can be compared again. */
  wholeTableDiffers: boolean;
  chunks: PendingChunk[];
  settledRows: number;
  /** Chunks (or a whole table without a primary key) compared by hash that matched again. */
  settledChunks: number;
}

export const isPending = (t: PendingTable) => t.wholeTableDiffers || t.chunks.length > 0;

/** Looks at a table's pending differences again, in fresh snapshots, and drops the settled ones. */
export async function recheckTable(source: pg.PoolClient, target: pg.PoolClient, t: PendingTable): Promise<void> {
  if (t.wholeTableDiffers) {
    const [hs, ht] = await Promise.all([hashWholeTable(source, t.spec), hashWholeTable(target, t.spec)]);
    if (hs.hash === ht.hash) {
      t.wholeTableDiffers = false;
      t.settledChunks++;
    }
    return;
  }

  const still: PendingChunk[] = [];
  for (const p of t.chunks) {
    if (p.rows) {
      const keys = p.rows.map((r) => r.key);
      const [sRows, tRows] = await Promise.all([fetchRowsByKeys(source, t.spec, keys), fetchRowsByKeys(target, t.spec, keys)]);
      const { remaining, settled } = settleRows(p.rows, compareRows(t.spec, sRows, tRows));
      t.settledRows += settled;
      if (remaining.length > 0) still.push({ ...p, rows: remaining });
    } else {
      const [hs, ht] = await Promise.all([hashRange(source, t.spec, p.chunk.range), hashRange(target, t.spec, p.chunk.range)]);
      if (hs.hash === ht.hash) t.settledChunks++;
      else still.push(p);
    }
  }
  t.chunks = still;
}

/**
 * Pure: `before` are the differences still pending, `now` is a fresh comparison of the
 * same keys. A key missing from `now` matches on both sides now: it caught up. A key
 * still in `now` keeps its new values, flagged when the source row itself changed in
 * between (still being written: in flight, not necessarily wrong).
 */
export function settleRows(before: RowDiff[], now: RowDiff[]): { remaining: RowDiff[]; settled: number } {
  const current = new Map(now.map((d) => [rowKeyId(d.key), d]));
  const remaining: RowDiff[] = [];
  for (const prev of before) {
    const d = current.get(rowKeyId(prev.key));
    if (!d) continue;
    const sourceChanging = prev.sourceChanging || sourceSide(prev) !== sourceSide(d);
    remaining.push(sourceChanging ? { ...d, sourceChanging } : d);
  }
  return { remaining, settled: before.length - remaining.length };
}

/** The source row as it was seen, comparable across checks ("" = not on the source). */
function sourceSide(d: RowDiff): string {
  return d.kind === "extra_in_target" ? "" : JSON.stringify(d.source);
}
