import pg from "pg";
import { quoteIdent } from "../../src/sql/ident.js";

// Test/eval infrastructure only. DriftGuard itself never uses admin credentials.
// These connect to the maintenance database "postgres" because CREATE/DROP DATABASE
// can't run while connected to the database being copied or dropped.
export const SOURCE_ADMIN_URL = process.env.SOURCE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5433/postgres";
export const TARGET_ADMIN_URL = process.env.TARGET_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5434/postgres";

export const SOURCE_RO_URL =
  process.env.SOURCE_DATABASE_URL ?? "postgres://driftguard_ro:driftguard_ro_local@localhost:5433/fintech";
export const TARGET_RO_URL =
  process.env.TARGET_DATABASE_URL ?? "postgres://driftguard_ro:driftguard_ro_local@localhost:5434/fintech";

/** Same URL, different database name. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

async function adminQuery(adminUrl: string, sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/**
 * Copies the seeded `fintech` database into a fresh scratch database on the same
 * server. STRATEGY FILE_COPY copies data files directly, which takes seconds for the
 * ~500 MB seed (re-seeding would take minutes). Grants and the read-only role's
 * privileges are copied along with the tables.
 */
export async function createScratchDatabase(adminUrl: string, name: string): Promise<void> {
  await dropScratchDatabase(adminUrl, name);
  await adminQuery(adminUrl, `CREATE DATABASE ${quoteIdent(name)} TEMPLATE fintech STRATEGY FILE_COPY`);
}

export async function dropScratchDatabase(adminUrl: string, name: string): Promise<void> {
  await adminQuery(adminUrl, `DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
}

/** Runs SQL as the superuser inside a scratch database (to create known drift). */
export async function runAsAdmin(adminUrl: string, database: string, sql: string): Promise<void> {
  await adminQuery(withDatabase(adminUrl, database), sql);
}
