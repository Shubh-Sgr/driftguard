import type pg from "pg";

/**
 * One database connection inside a REPEATABLE READ, READ ONLY transaction.
 *
 * REPEATABLE READ means every query in the transaction sees the same snapshot, so all
 * chunks of a table (and all tables) are compared at one point in time, even while
 * the application keeps writing.
 */
export interface Snapshot {
  client: pg.PoolClient;
  close(): Promise<void>;
}

// row::text depends on these session settings. If source and target servers had
// different defaults (e.g. TimeZone), identical data would hash differently.
// SET LOCAL applies only inside this transaction.
const NORMALIZE = [
  "SET LOCAL TimeZone = 'UTC'",
  "SET LOCAL DateStyle = 'ISO, YMD'",
  "SET LOCAL IntervalStyle = 'postgres'",
  "SET LOCAL extra_float_digits = 3", // print floats with full precision
  "SET LOCAL bytea_output = 'hex'",
];

export async function openSnapshot(pool: pg.Pool): Promise<Snapshot> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    for (const sql of NORMALIZE) await client.query(sql);
  } catch (err) {
    client.release();
    throw err;
  }
  return {
    client,
    async close() {
      try {
        // Read-only, so ROLLBACK and COMMIT are equivalent; ROLLBACK is the safer habit.
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    },
  };
}
