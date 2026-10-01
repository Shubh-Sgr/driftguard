import type pg from "pg";
import type { Schema } from "../introspect/types.js";
import { qualify, quoteIdent } from "../sql/ident.js";

/**
 * One identity/serial column on the TARGET and whether its sequence is ahead of the data.
 * Values are text (bigint-safe), compared as BigInt.
 */
export interface SequenceCheck {
  table: string;
  column: string;
  sequence: string;
  /** What the next nextval() returns, or null when it can't be read (no privilege). */
  nextValue: string | null;
  /** max(column), or min(column) for a descending sequence; null for an empty table. */
  dataValue: string | null;
  /**
   * ok: the next value is past every existing value.
   * behind: the next INSERT that uses the default can collide with an existing row.
   * unknown: the sequence state isn't readable with this role.
   */
  status: "ok" | "behind" | "unknown";
  /** For "behind": the statement that fixes it (PgVouch never runs it). */
  fix?: string;
}

/**
 * After copying data (pg_dump --data-only, COPY, logical replication, a cloud migration
 * service), the rows arrive but sequences often don't move: the classic outage where the
 * first INSERT on the new database fails with a duplicate key. This checks every column
 * fed by a sequence (identity or serial) on the target: the next value must be past the
 * largest existing value. Read-only: pg_sequences and one max()/min() per column.
 */
export async function checkSequences(client: pg.PoolClient, schema: Schema, tables: string[]): Promise<SequenceCheck[]> {
  const checks: SequenceCheck[] = [];
  for (const key of tables) {
    const t = schema.tables[key];
    if (!t) continue;
    for (const col of Object.values(t.columns).sort((a, b) => a.position - b.position)) {
      if (!col.identity && !/^nextval\(/.test(col.default ?? "")) continue;
      const { rows } = await client.query(
        // pg_get_serial_sequence takes the table name per SQL rules and the column literally.
        `SELECT s.seq,
                ps.last_value::text AS last_value, ps.start_value::text AS start_value,
                ps.increment_by::text AS increment,
                has_sequence_privilege(s.seq, 'SELECT') AS readable
         FROM (SELECT pg_get_serial_sequence($1, $2) AS seq) s
         LEFT JOIN pg_sequences ps ON format('%I.%I', ps.schemaname, ps.sequencename) = s.seq`,
        [qualify(t.schema, t.name), col.name],
      );
      const r = rows[0];
      if (!r?.seq) continue; // a default that calls nextval() on an unrelated sequence
      const ascending = !String(r.increment).startsWith("-");
      const agg = ascending ? "max" : "min";
      const data = await client.query(`SELECT ${agg}(${quoteIdent(col.name)})::text AS v FROM ${qualify(t.schema, t.name)}`);
      const dataValue: string | null = data.rows[0]?.v ?? null;

      // pg_sequences.last_value is NULL both when nextval() was never called (then the next
      // value is start_value) and when we lack privileges (then we can't tell).
      const nextValue: string | null = r.last_value !== null
        ? (BigInt(r.last_value) + BigInt(r.increment)).toString()
        : r.readable ? r.start_value : null;

      let status: SequenceCheck["status"] = "unknown";
      if (nextValue !== null) {
        status = dataValue === null ? "ok"
          : ascending ? (BigInt(nextValue) > BigInt(dataValue) ? "ok" : "behind")
          : (BigInt(nextValue) < BigInt(dataValue) ? "ok" : "behind");
      }
      checks.push({
        table: key,
        column: col.name,
        sequence: r.seq,
        nextValue,
        dataValue,
        status,
        ...(status === "behind"
          ? { fix: `SELECT setval('${r.seq.replace(/'/g, "''")}', (SELECT ${agg}(${quoteIdent(col.name)}) FROM ${qualify(t.schema, t.name)}));` }
          : {}),
      });
    }
  }
  return checks;
}
