import type pg from "pg";

export interface ConnectionReport {
  serverVersion: string;
  user: string;
  readOnly: boolean;
  statementTimeout: string;
  canWriteAnyTable: boolean;
  tableCount: number;
}

/**
 * Checks what the connection is actually allowed to do, as seen by the server.
 * We trust these server-reported values, not our own config, so the output proves
 * the safety settings really took effect.
 */
export async function inspectConnection(pool: pg.Pool): Promise<ConnectionReport> {
  const { rows } = await pool.query<{
    server_version: string;
    current_user: string;
    transaction_read_only: string;
    statement_timeout: string;
    can_write: boolean;
    table_count: string;
  }>(`
    SELECT current_setting('server_version')        AS server_version,
           current_user                             AS current_user,
           current_setting('transaction_read_only') AS transaction_read_only,
           current_setting('statement_timeout')     AS statement_timeout,
           -- True if this role holds any write privilege on any user table.
           EXISTS (
             SELECT 1
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relkind IN ('r', 'p')
               AND n.nspname NOT IN ('pg_catalog', 'information_schema')
               AND has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
           )                                        AS can_write,
           (SELECT count(*)
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p')
              AND n.nspname NOT IN ('pg_catalog', 'information_schema')) AS table_count
  `);
  const row = rows[0]!; // a SELECT without FROM always returns exactly one row
  return {
    serverVersion: row.server_version,
    user: row.current_user,
    readOnly: row.transaction_read_only === "on",
    statementTimeout: row.statement_timeout,
    canWriteAnyTable: row.can_write,
    // count(*) is bigint, which pg returns as a string to avoid precision loss.
    tableCount: Number(row.table_count),
  };
}
