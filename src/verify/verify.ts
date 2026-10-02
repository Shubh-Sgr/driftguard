import type pg from "pg";
import { introspect } from "../introspect/introspect.js";
import type { Schema } from "../introspect/types.js";
import { findDifferingRows, type BisectOptions, type BisectStats, type RowDiff } from "./bisect.js";
import { chunkRanges, hashRange, hashWholeTable, type RangeHash } from "./checksum.js";
import { isPending, recheckTable, type PendingChunk, type PendingTable } from "./recheck.js";
import { checkSequences, type SequenceCheck } from "./sequences.js";
import { openSnapshot, type Snapshot } from "./snapshot.js";
import { buildTableSpec, describeRange, type KeyRange, type TableSpec } from "./table.js";

export interface MismatchedChunk {
  range: KeyRange;
  description: string;
  /** Hashes and row counts from the first check (a recheck doesn't replace them). */
  source: RangeHash;
  target: RangeHash;
}

export interface TableVerification {
  table: string;
  status: "match" | "mismatch" | "skipped";
  /** False for tables without a primary key: we know THAT they differ, not WHERE. */
  localized: boolean;
  sourceRows: number;
  targetRows: number;
  chunks: number;
  mismatchedChunks: MismatchedChunk[];
  reason?: string;
  /** Caveats about what was compared (e.g. row-level security hid rows from this role). */
  notes?: string[];
  /** Only filled when findRows is on. */
  differingRows?: RowDiff[];
  bisect?: BisectStats & { truncated: boolean };
  /** Only filled when recheck is on and the first check found differences. */
  recheck?: {
    /** Differing rows that matched on a later check (in flight, not wrong). */
    settledRows: number;
    /** Chunks without a complete row list (or a table without a primary key), re-hashed and matching on a later check. */
    settledChunks: number;
    /** Rows still differing whose source row also changed between checks. */
    stillChanging: number;
  };
}

export interface VerifyReport {
  /** Data equality only. Sequence health is reported separately in `sequencesOk`. */
  identical: boolean;
  tables: TableVerification[];
  /** Identity/serial sequences on the TARGET, each checked against the data it feeds. */
  sequences: SequenceCheck[];
  /** False if a target sequence is behind its data (the next INSERT can hit a duplicate key). */
  sequencesOk: boolean;
  /** Present when recheck was asked for: how many recheck rounds actually ran. */
  recheck?: { rounds: number; delayMs: number };
  elapsedMs: number;
}

export interface VerifyOptions extends BisectOptions {
  tables?: string[];
  schemas?: string[];
  chunkSize?: number;
  /** Also run F4 bisection on mismatched chunks to list the exact rows. */
  findRows?: boolean;
  /**
   * Lag tolerance: look at the differences again up to this many times, after
   * `recheckDelayMs` each, and report only those that never caught up. Default 0 (off).
   */
  recheck?: number;
  /** Wait before each recheck; default 5000. */
  recheckDelayMs?: number;
  /** How to wait between rechecks. Tests replace it to change data mid-run. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * F3: proves table data is identical on two databases by comparing per-chunk hashes.
 * Both sides run inside their own REPEATABLE READ snapshot for the whole run.
 */
export async function verifyData(sourcePool: pg.Pool, targetPool: pg.Pool, opts: VerifyOptions = {}): Promise<VerifyReport> {
  const started = Date.now();
  const recheck = opts.recheck ?? 0;
  const delayMs = opts.recheckDelayMs ?? 5000;
  if (!Number.isInteger(recheck) || recheck < 0) throw new Error("recheck must be a whole number >= 0");
  if (!(delayMs >= 0)) throw new Error("recheckDelayMs must be >= 0");

  const { tables, sequences, pending } = await firstCheck(sourcePool, targetPool, opts, recheck > 0);
  const report: VerifyReport = {
    identical: false,
    tables,
    sequences,
    sequencesOk: sequences.every((s) => s.status !== "behind"),
    elapsedMs: 0,
  };
  if (recheck > 0) {
    report.recheck = { rounds: await recheckDifferences(sourcePool, targetPool, pending, recheck, delayMs, opts.wait ?? sleep), delayMs };
    for (const [table, p] of pending) applyRecheck(table, p, opts.findRows ?? false);
  }
  report.identical = tables.every((t) => t.status === "match");
  report.elapsedMs = Date.now() - started;
  return report;
}

/** The F3 check itself: every table inside one REPEATABLE READ snapshot per side. */
async function firstCheck(sourcePool: pg.Pool, targetPool: pg.Pool, opts: VerifyOptions, keepPending: boolean) {
  const chunkSize = opts.chunkSize ?? 10_000;
  const [source, target] = await Promise.all([openSnapshot(sourcePool), openSnapshot(targetPool)]);

  try {
    // Introspect inside the snapshots so the schema matches the data we hash.
    const [sourceSchema, targetSchema] = await Promise.all([
      introspect(source.client, opts.schemas),
      introspect(target.client, opts.schemas),
    ]);

    const tables: TableVerification[] = [];
    const pending = new Map<TableVerification, PendingTable>();
    const keys = selectTables(sourceSchema, targetSchema, opts.tables, opts.schemas);
    const [sourceBypass, targetBypass] = await Promise.all([bypassesRls(source.client), bypassesRls(target.client)]);
    for (const key of keys) {
      const { result, recheck } = await verifyTable(source, target, sourceSchema, targetSchema, key, chunkSize, opts, keepPending);
      // With row-level security on, a role without BYPASSRLS only sees the rows its
      // policies allow: "identical" would then only be about those rows. Say so.
      const hidden = [
        !sourceBypass && sourceSchema.tables[key]?.rowSecurity?.enabled ? "source" : null,
        !targetBypass && targetSchema.tables[key]?.rowSecurity?.enabled ? "target" : null,
      ].filter(Boolean);
      if (hidden.length && result.status !== "skipped") {
        result.notes = [`row-level security is on (${hidden.join(", ")}): only the rows this role's policies allow were compared; use a role with BYPASSRLS to compare every row`];
      }
      tables.push(result);
      if (recheck) pending.set(result, recheck);
    }
    // Copied data with sequences left behind is a classic post-migration outage, so a
    // data check also checks that the target's sequences are past its data.
    const sequences = await checkSequences(target.client, targetSchema, keys);
    return { tables, sequences, pending };
  } finally {
    await Promise.all([source.close(), target.close()]);
  }
}

/** Recheck rounds, each in a new pair of snapshots. Returns how many rounds ran. */
async function recheckDifferences(
  sourcePool: pg.Pool,
  targetPool: pg.Pool,
  pending: Map<TableVerification, PendingTable>,
  maxRounds: number,
  delayMs: number,
  wait: (ms: number) => Promise<void>,
): Promise<number> {
  let rounds = 0;
  while (rounds < maxRounds && [...pending.values()].some(isPending)) {
    await wait(delayMs);
    const [source, target] = await Promise.all([openSnapshot(sourcePool), openSnapshot(targetPool)]);
    try {
      for (const p of pending.values()) if (isPending(p)) await recheckTable(source.client, target.client, p);
    } finally {
      await Promise.all([source.close(), target.close()]);
    }
    rounds++;
  }
  return rounds;
}

/** Writes what the rechecks found back into the table's result. */
function applyRecheck(result: TableVerification, p: PendingTable, findRows: boolean): void {
  const rows = p.chunks.flatMap((c) => c.rows ?? c.partialRows);
  const stillChanging = rows.filter((r) => r.sourceChanging).length;
  result.recheck = { settledRows: p.settledRows, settledChunks: p.settledChunks, stillChanging };
  if (!result.localized) {
    // No primary key: the whole table was compared again.
    if (!isPending(p)) Object.assign(result, { status: "match", reason: undefined });
  } else {
    result.mismatchedChunks = p.chunks.map((c) => c.chunk);
    result.status = result.mismatchedChunks.length > 0 ? "mismatch" : "match";
    if (findRows) result.differingRows = rows;
  }

  const notes: string[] = [];
  if (p.settledRows || p.settledChunks) {
    const what = [p.settledRows && `${p.settledRows} row(s)`, p.settledChunks && (result.localized ? `${p.settledChunks} chunk(s)` : "the table")].filter(Boolean).join(" and ");
    notes.push(`${what} that differed at first matched on a recheck (in flight, e.g. replication lag)`);
  }
  if (p.chunks.some((c) => !c.rows)) {
    notes.push("some chunks had too many differing rows to recheck row by row and were rechecked as whole chunks; new writes in their key range keep them differing");
  }
  if (stillChanging) notes.push(`${stillChanging} still-differing row(s) were also changing on the source between checks: they may be in flight rather than wrong`);
  if (notes.length) result.notes = [...(result.notes ?? []), ...notes];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function bypassesRls(client: pg.PoolClient): Promise<boolean> {
  const { rows } = await client.query<{ bypass: boolean }>("SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user");
  return rows[0]?.bypass ?? false;
}

function selectTables(source: Schema, target: Schema, requested?: string[], schemas: string[] = ["public"]): string[] {
  const all = Object.keys(source.tables).sort();
  if (!requested?.length) return all;
  // A bare name ("transactions") means that table in the verified schemas (public by default).
  const exists = (k: string) => !!source.tables[k] || !!target.tables[k];
  const keys = requested.map((name) => {
    if (name.includes(".")) return name;
    return schemas.map((s) => `${s}.${name}`).find(exists) ?? `${schemas[0] ?? "public"}.${name}`;
  });
  // A typo would otherwise be reported as "DIFFERENCES FOUND: table missing on source".
  // A table on only one side is real drift and is still reported (as skipped).
  const unknown = keys.filter((k) => !source.tables[k] && !target.tables[k]);
  if (unknown.length) throw new Error(`Unknown table(s), not found on source or target: ${unknown.join(", ")}`);
  return keys;
}

async function verifyTable(
  source: Snapshot,
  target: Snapshot,
  sourceSchema: Schema,
  targetSchema: Schema,
  key: string,
  chunkSize: number,
  opts: VerifyOptions,
  keepPending: boolean,
): Promise<{ result: TableVerification; recheck?: PendingTable }> {
  const base: TableVerification = {
    table: key,
    status: "skipped",
    localized: true,
    sourceRows: 0,
    targetRows: 0,
    chunks: 0,
    mismatchedChunks: [],
  };

  const s = sourceSchema.tables[key];
  const t = targetSchema.tables[key];
  if (!s || !t) return { result: { ...base, reason: `table missing on ${s ? "target" : "source"}` } };

  const spec = buildTableSpec(s, t);
  if ("skip" in spec) return { result: { ...base, reason: spec.skip } };

  if (!spec.primaryKey) {
    const result = await verifyWithoutPrimaryKey(source, target, spec, base);
    const recheck = keepPending && result.status === "mismatch" ? pendingTable(spec, true, []) : undefined;
    return { result, recheck };
  }

  const ranges = await chunkRanges(source.client, spec, chunkSize);
  const result: TableVerification = { ...base, status: "match", chunks: ranges.length };

  for (const range of ranges) {
    // Same query on both databases at the same time.
    const [hs, ht] = await Promise.all([hashRange(source.client, spec, range), hashRange(target.client, spec, range)]);
    result.sourceRows += hs.rows;
    result.targetRows += ht.rows;
    if (hs.hash !== ht.hash) {
      result.mismatchedChunks.push({ range, description: describeRange(range), source: hs, target: ht });
    }
  }

  if (result.mismatchedChunks.length === 0) return { result };
  result.status = "mismatch";
  // A recheck needs the exact rows (see recheck.ts), so it bisects even without findRows.
  if (!opts.findRows && !keepPending) return { result };
  const perChunk = await attachDifferingRows(source, target, spec, result, opts);
  if (!opts.findRows) {
    delete result.differingRows;
    delete result.bisect;
  }
  return { result, recheck: keepPending ? pendingTable(spec, false, perChunk) : undefined };
}

const pendingTable = (spec: TableSpec, wholeTableDiffers: boolean, chunks: PendingChunk[]): PendingTable => ({
  spec,
  wholeTableDiffers,
  chunks,
  settledRows: 0,
  settledChunks: 0,
});

async function verifyWithoutPrimaryKey(
  source: Snapshot,
  target: Snapshot,
  spec: TableSpec,
  base: TableVerification,
): Promise<TableVerification> {
  const [hs, ht] = await Promise.all([hashWholeTable(source.client, spec), hashWholeTable(target.client, spec)]);
  const same = hs.hash === ht.hash;
  return {
    ...base,
    status: same ? "match" : "mismatch",
    localized: false,
    sourceRows: hs.rows,
    targetRows: ht.rows,
    chunks: 1,
    reason: same ? undefined : "table has no primary key: mismatch detected but rows cannot be localized",
  };
}

/** F4: bisect every mismatched chunk, sharing one row budget across the table. */
async function attachDifferingRows(
  source: Snapshot,
  target: Snapshot,
  spec: TableSpec,
  result: TableVerification,
  opts: BisectOptions,
): Promise<PendingChunk[]> {
  const maxRows = opts.maxRows ?? 1000;
  const rows: RowDiff[] = [];
  const total = { hashQueries: 0, rowsFetched: 0, maxDepth: 0, truncated: false };
  // Per chunk, for a recheck: the complete list of its rows, or null if bisection stopped early.
  const perChunk: PendingChunk[] = result.mismatchedChunks.map((chunk) => ({ chunk, rows: null, partialRows: [] }));

  for (const p of perChunk) {
    const remaining = maxRows - rows.length;
    if (remaining <= 0) {
      total.truncated = true;
      break;
    }
    const r = await findDifferingRows(source.client, target.client, spec, p.chunk.range, p.chunk, { ...opts, maxRows: remaining });
    rows.push(...r.rows);
    total.hashQueries += r.stats.hashQueries;
    total.rowsFetched += r.stats.rowsFetched;
    total.maxDepth = Math.max(total.maxDepth, r.stats.maxDepth);
    total.truncated ||= r.truncated;
    p.partialRows = r.rows;
    if (!r.truncated && r.rows.length > 0) p.rows = r.rows;
  }
  result.differingRows = rows;
  result.bisect = total;
  return perChunk;
}

/**
 * Standalone F4 entry point (used by the MCP tool): verify one table and return
 * its differing rows.
 */
export async function findDifferingRowsInTable(
  sourcePool: pg.Pool,
  targetPool: pg.Pool,
  table: string,
  opts: Omit<VerifyOptions, "tables" | "findRows"> = {},
): Promise<TableVerification> {
  const report = await verifyData(sourcePool, targetPool, { ...opts, tables: [table], findRows: true });
  return report.tables[0]!;
}
