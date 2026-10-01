import pg from "pg";
import { quoteIdent } from "../../src/sql/ident.js";

// Test/eval infrastructure only. PgVouch itself never uses admin credentials.
// These connect to the maintenance database "postgres" because CREATE/DROP DATABASE
// can't run while connected to the database being copied or dropped.
export const SOURCE_ADMIN_URL = process.env.SOURCE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5433/postgres";
export const TARGET_ADMIN_URL = process.env.TARGET_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5434/postgres";

export const SOURCE_RO_URL =
  process.env.SOURCE_DATABASE_URL ?? "postgres://pgvouch_ro:pgvouch_ro_local@localhost:5433/fintech";
export const TARGET_RO_URL =
  process.env.TARGET_DATABASE_URL ?? "postgres://pgvouch_ro:pgvouch_ro_local@localhost:5434/fintech";

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
 * server. File copy takes seconds for the ~500 MB seed (re-seeding would take minutes).
 * Grants and the read-only role's privileges are copied along with the tables.
 * PG 15 made WAL_LOG the default strategy (slow for a big template), so ask for
 * FILE_COPY there; before 15 file copy is the only strategy and the option doesn't exist.
 */
export async function createScratchDatabase(adminUrl: string, name: string): Promise<void> {
  await dropScratchDatabase(adminUrl, name);
  const strategy = (await serverVersionNum(adminUrl)) >= 150_000 ? " STRATEGY FILE_COPY" : "";
  await adminQuery(adminUrl, `CREATE DATABASE ${quoteIdent(name)} TEMPLATE fintech${strategy}`);
}

async function serverVersionNum(adminUrl: string): Promise<number> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return Number((await client.query("SHOW server_version_num")).rows[0].server_version_num);
  } finally {
    await client.end();
  }
}

export async function dropScratchDatabase(adminUrl: string, name: string): Promise<void> {
  await adminQuery(adminUrl, `DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
}

/** Runs SQL as the superuser inside a scratch database (to create known drift). */
export async function runAsAdmin(adminUrl: string, database: string, sql: string): Promise<void> {
  await adminQuery(withDatabase(adminUrl, database), sql);
}
