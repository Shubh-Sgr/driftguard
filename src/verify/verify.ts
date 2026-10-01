import type pg from "pg";
import { introspect } from "../introspect/introspect.js";
import type { Schema } from "../introspect/types.js";
import { findDifferingRows, type BisectOptions, type BisectStats, type RowDiff } from "./bisect.js";
import { chunkRanges, hashRange, hashWholeTable, type RangeHash } from "./checksum.js";
import { checkSequences, type SequenceCheck } from "./sequences.js";
import { openSnapshot, type Snapshot } from "./snapshot.js";
import { buildTableSpec, describeRange, type KeyRange, type TableSpec } from "./table.js";

export interface MismatchedChunk {
  range: KeyRange;
  description: string;
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
}

export interface VerifyReport {
  /** Data equality only. Sequence health is reported separately in `sequencesOk`. */
  identical: boolean;
  tables: TableVerification[];
  /** Identity/serial sequences on the TARGET, each checked against the data it feeds. */
  sequences: SequenceCheck[];
  /** False if a target sequence is behind its data (the next INSERT can hit a duplicate key). */
  sequencesOk: boolean;
  elapsedMs: number;
}

export interface VerifyOptions extends BisectOptions {
  tables?: string[];
  schemas?: string[];
  chunkSize?: number;
  /** Also run F4 bisection on mismatched chunks to list the exact rows. */
  findRows?: boolean;
}

/**
 * F3: proves table data is identical on two databases by comparing per-chunk hashes.
 * Both sides run inside their own REPEATABLE READ snapshot for the whole run.
 */
export async function verifyData(sourcePool: pg.Pool, targetPool: pg.Pool, opts: VerifyOptions = {}): Promise<VerifyReport> {
  const started = Date.now();
  const chunkSize = opts.chunkSize ?? 10_000;
  const [source, target] = await Promise.all([openSnapshot(sourcePool), openSnapshot(targetPool)]);

  try {
    // Introspect inside the snapshots so the schema matches the data we hash.
    const [sourceSchema, targetSchema] = await Promise.all([
      introspect(source.client, opts.schemas),
      introspect(target.client, opts.schemas),
    ]);

    const tables: TableVerification[] = [];
    const keys = selectTables(sourceSchema, targetSchema, opts.tables, opts.schemas);
    const [sourceBypass, targetBypass] = await Promise.all([bypassesRls(source.client), bypassesRls(target.client)]);
    for (const key of keys) {
      const result = await verifyTable(source, target, sourceSchema, targetSchema, key, chunkSize, opts);
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
    }
    // Copied data with sequences left behind is a classic post-migration outage, so a
    // data check also checks that the target's sequences are past its data.
    const sequences = await checkSequences(target.client, targetSchema, keys);
    return {
      identical: tables.every((t) => t.status === "match"),
      tables,
      sequences,
      sequencesOk: sequences.every((s) => s.status !== "behind"),
      elapsedMs: Date.now() - started,
    };
  } finally {
    await Promise.all([source.close(), target.close()]);
  }
}

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
): Promise<TableVerification> {
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
  if (!s || !t) return { ...base, reason: `table missing on ${s ? "target" : "source"}` };

  const spec = buildTableSpec(s, t);
  if ("skip" in spec) return { ...base, reason: spec.skip };

  if (!spec.primaryKey) return verifyWithoutPrimaryKey(source, target, spec, base);

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

  if (result.mismatchedChunks.length > 0) {
    result.status = "mismatch";
    if (opts.findRows) await attachDifferingRows(source, target, spec, result, opts);
  }
  return result;
}

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
): Promise<void> {
  const maxRows = opts.maxRows ?? 1000;
  const rows: RowDiff[] = [];
  const total = { hashQueries: 0, rowsFetched: 0, maxDepth: 0, truncated: false };

  for (const chunk of result.mismatchedChunks) {
    const remaining = maxRows - rows.length;
    if (remaining <= 0) {
      total.truncated = true;
      break;
    }
    const r = await findDifferingRows(source.client, target.client, spec, chunk.range, chunk, { ...opts, maxRows: remaining });
    rows.push(...r.rows);
    total.hashQueries += r.stats.hashQueries;
    total.rowsFetched += r.stats.rowsFetched;
    total.maxDepth = Math.max(total.maxDepth, r.stats.maxDepth);
    total.truncated ||= r.truncated;
  }
  result.differingRows = rows;
  result.bisect = total;
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
