import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db.js";
import { verifyData } from "../../src/verify/verify.js";
import { withDatabase } from "../../evals/lib/scratch.js";
import { SOURCE_RO_URL, TARGET_RO_URL } from "./env.js";

// Two databases holding IDENTICAL rows whose text primary key sorts differently: byte
// order ("C") on the source, ICU's linguistic order on the target. That's what happens
// when a database moves to a server with another collation or libc/ICU version.
// Without byte-wise key ordering, chunk ranges and hashes would disagree on identical data.
const DB = "dg_test_collation";
const ADMIN = {
  source: process.env.SOURCE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5433/postgres",
  target: process.env.TARGET_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5434/postgres",
};
// Mixed case, digits and punctuation: C and ICU order these very differently.
const KEYS = Array.from({ length: 300 }, (_, i) => `${["a", "B", "c", "D", "_e", "F", "9g", "h-"][i % 8]}${i}`);

async function admin(url: string, sql: string) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await c.query(sql);
  } finally {
    await c.end();
  }
}

let icu: string | undefined;
let source: pg.Pool;
let target: pg.Pool;

beforeAll(async () => {
  icu = (await admin(ADMIN.target, "SELECT collname FROM pg_collation WHERE collname = 'und-x-icu'")).rows[0]?.collname;
  for (const [side, url] of Object.entries(ADMIN)) {
    await admin(url, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin(url, `CREATE DATABASE ${DB}`);
    const collation = side === "source" || !icu ? "C" : icu;
    const values = KEYS.map((k, i) => `('${k}', ${i})`).join(", ");
    await admin(withDatabase(url, DB), `
      CREATE TABLE codes (k text COLLATE "${collation}" PRIMARY KEY, v int NOT NULL);
      INSERT INTO codes VALUES ${values};
      GRANT SELECT ON codes TO pgvouch_ro;`);
  }
  source = createPool(withDatabase(SOURCE_RO_URL, DB), { statementTimeoutMs: 30_000 });
  target = createPool(withDatabase(TARGET_RO_URL, DB), { statementTimeoutMs: 30_000 });
});

afterAll(async () => {
  await Promise.all([source?.end(), target?.end()]);
  for (const url of Object.values(ADMIN)) await admin(url, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
});

describe("verify with different collations on source and target", () => {
  it("the two databases really sort the keys differently", async (ctx) => {
    if (!icu) ctx.skip(); // a Postgres build without ICU
    const order = async (pool: pg.Pool) => (await pool.query("SELECT array_agg(k ORDER BY k) AS o FROM codes")).rows[0].o;
    expect(await order(source)).not.toEqual(await order(target));
  });

  it("reports identical data as identical, with small chunks across the whole key range", async () => {
    const report = await verifyData(source, target, { tables: ["codes"], chunkSize: 7, findRows: true });
    expect(report.tables[0]).toMatchObject({ status: "match", sourceRows: 300, targetRows: 300, mismatchedChunks: [] });
    expect(report.tables[0]!.chunks).toBeGreaterThan(40);
  });

  it("still finds a real difference", async () => {
    await admin(withDatabase(ADMIN.target, DB), "UPDATE codes SET v = -1 WHERE k = 'D3'");
    const report = await verifyData(source, target, { tables: ["codes"], chunkSize: 7, findRows: true });
    expect(report.tables[0]!.differingRows).toEqual([expect.objectContaining({ kind: "changed", key: { k: "D3" }, columns: ["v"] })]);
  });
});
