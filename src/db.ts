import pg from "pg";

export interface PoolOptions {
  statementTimeoutMs: number;
  /** Shows up in pg_stat_activity so a DBA can see who is querying. */
  applicationName?: string;
}

/**
 * Creates a connection pool that is read-only and time-limited at the session level.
 *
 * This is the second safety layer. The first is the database role itself
 * (SELECT-only + default_transaction_read_only, see docker/seed/00_roles.sql),
 * so even if someone points DriftGuard at a superuser URL, every transaction
 * still starts READ ONLY and every query is still capped by statement_timeout.
 */
export function createPool(connectionString: string, opts: PoolOptions): pg.Pool {
  return new pg.Pool({
    connectionString,
    // Small pool: DriftGuard runs a few analytical queries, not web traffic.
    max: 4,
    application_name: opts.applicationName ?? "driftguard",
    // Sent in the startup packet, so it applies before our first query runs.
    statement_timeout: opts.statementTimeoutMs,
    options: [
      "-c default_transaction_read_only=on",
      // Our reads take ACCESS SHARE locks. If a migration holds ACCESS EXCLUSIVE,
      // give up quickly instead of queueing (and making other queries queue behind us).
      "-c lock_timeout=5000",
      "-c idle_in_transaction_session_timeout=60000",
    ].join(" "),
  });
}
