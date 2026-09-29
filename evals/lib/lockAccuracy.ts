import { readFile } from "node:fs/promises";
import pg from "pg";
import { createPool } from "../../src/db.js";
import { introspect } from "../../src/introspect/introspect.js";
import { analyzeMigration } from "../../src/locks/analyze.js";
import { strongest, type LockMode } from "../../src/locks/modes.js";
import { createScratchDatabase, dropScratchDatabase, runAsAdmin, TARGET_ADMIN_URL, TARGET_RO_URL, withDatabase } from "./scratch.js";

export interface LockCase {
  sql: string;
  table: string;
  predictedMode: LockMode | null;
  measuredMode: LockMode | null;
  modeCorrect: boolean;
  predictedRewrite: boolean;
  /** null when a rewrite can't be measured (table dropped/truncated). */
  measuredRewrite: boolean | null;
  method: "in-transaction" | "observed-while-waiting";
  error?: string;
}

// pg_locks reports modes as e.g. "AccessExclusiveLock"; convert to "ACCESS EXCLUSIVE".
const toMode = (m: string): LockMode => m.replace(/Lock$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase() as LockMode;

/**
 * Ground truth comes from Postgres, not from us:
 *  - lock mode: run the statement inside BEGIN ... ROLLBACK and read the locks this
 *    backend holds on the table from pg_locks;
 *  - table rewrite: pg_class.relfilenode (the table's data file) changes iff Postgres
 *    wrote a new copy of the table.
 * Statements that can't run in a transaction (CONCURRENTLY, VACUUM) are measured from
 * a second session while the statement is made to wait (see measureOutsideTransaction).
 */
export async function runLockAccuracy(corpusPath: string, prepPath: string, log = console.log): Promise<LockCase[]> {
  const corpus = JSON.parse(await readFile(corpusPath, "utf8")) as { sql: string; table: string }[];
  const db = "eval_locks";
  await createScratchDatabase(TARGET_ADMIN_URL, db);
  await runAsAdmin(TARGET_ADMIN_URL, db, await readFile(prepPath, "utf8"));

  const ro = createPool(withDatabase(TARGET_RO_URL, db), { statementTimeoutMs: 60_000 });
  const schema = await introspect(ro);
  await ro.end();

  const url = withDatabase(TARGET_ADMIN_URL, db);
  const runner = new pg.Client({ connectionString: url });
  const observer = new pg.Client({ connectionString: url });
  await runner.connect();
  await observer.connect();
  await runner.query("SET lock_timeout = '20s'");
  const runnerPid: number = (await runner.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;

  const results: LockCase[] = [];
  try {
    for (const item of corpus) {
      log(`[locks] ${item.sql}`);
      const predicted = (await analyzeMigration(item.sql, schema)).statements[0]!;
      const table = `public.${item.table}`;
      const measurable = !/^(TRUNCATE|DROP TABLE)/i.test(item.sql);
      const base = { sql: item.sql, table: item.table, predictedMode: predicted.lockMode, predictedRewrite: predicted.rewritesTable };

      let measuredMode: LockMode | null = null;
      let measuredRewrite: boolean | null = null;
      let method: LockCase["method"] = "in-transaction";
      let error: string | undefined;
      try {
        await runner.query("BEGIN");
        const before = await relfilenode(runner, table);
        await runner.query(item.sql);
        const { rows } = await runner.query(
          `SELECT mode FROM pg_locks WHERE locktype = 'relation' AND pid = pg_backend_pid() AND granted AND relation = to_regclass($1)`,
          [table],
        );
        measuredMode = rows.length ? strongest(rows.map((r) => toMode(r.mode))) : null;
        if (measurable) measuredRewrite = (await relfilenode(runner, table)) !== before;
        await runner.query("ROLLBACK");
      } catch (err) {
        await runner.query("ROLLBACK").catch(() => undefined);
        if ((err as { code?: string }).code !== "25001") {
          error = (err as Error).message; // a real failure, not "can't run in a transaction"
        } else {
          method = "observed-while-waiting";
          ({ measuredMode, measuredRewrite } = await measureOutsideTransaction(runner, observer, runnerPid, item.sql, table));
        }
      }

      results.push({ ...base, measuredMode, measuredRewrite, method, modeCorrect: measuredMode === predicted.lockMode, error });
    }
  } finally {
    await runner.end();
    await observer.end();
    await dropScratchDatabase(TARGET_ADMIN_URL, db);
  }
  return results;
}

async function measureOutsideTransaction(runner: pg.Client, observer: pg.Client, runnerPid: number, sql: string, table: string) {
  // The observer keeps a transaction open holding only ACCESS SHARE on the table. That
  // lets the statement take its early, weaker locks, but it must eventually WAIT: either
  // for a lock that conflicts with ACCESS SHARE (e.g. VACUUM FULL's ACCESS EXCLUSIVE) or,
  // for CONCURRENTLY, for older transactions like ours to finish. At that moment
  // pg_locks shows every relation lock it holds or is waiting for.
  await observer.query("BEGIN");
  await observer.query(`LOCK TABLE ${table} IN ACCESS SHARE MODE`);
  const before = await relfilenode(observer, table);
  const running = runner.query(sql).then(
    () => null,
    (e: Error) => e,
  );

  let measuredMode: LockMode | null = null;
  for (let i = 0; i < 500 && !measuredMode; i++) {
    const { rows } = await observer.query(
      `SELECT mode, granted, locktype = 'relation' AND relation = to_regclass($2) AS on_table FROM pg_locks WHERE pid = $1`,
      [runnerPid, table],
    );
    const waiting = rows.some((r) => !r.granted);
    const onTable = rows.filter((r) => r.on_table).map((r) => toMode(r.mode));
    if (waiting && onTable.length) measuredMode = strongest(onTable);
    else await new Promise((r) => setTimeout(r, 10));
  }
  await observer.query("ROLLBACK");
  const failure = await running;
  if (failure) throw failure;
  const after = await relfilenode(observer, table);
  return { measuredMode, measuredRewrite: after !== before };
}

async function relfilenode(client: pg.Client, table: string): Promise<string | null> {
  const { rows } = await client.query("SELECT relfilenode::text AS f FROM pg_class WHERE oid = to_regclass($1)", [table]);
  return rows[0]?.f ?? null;
}
