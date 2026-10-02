import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db.js";
import { diffSchemas } from "../../src/diff/diff.js";
import { driftItemKey } from "../../src/diff/types.js";
import { introspect } from "../../src/introspect/introspect.js";
import type { Schema } from "../../src/introspect/types.js";
import { planMigration } from "../../src/plan/plan.js";
import { shadowRun } from "../../src/shadow/shadow.js";
import { createScratchDatabase, dropScratchDatabase, runAsAdmin, withDatabase } from "../../evals/lib/scratch.js";
import { TARGET_ADMIN_URL, TARGET_RO_URL } from "./env.js";

// Shapes that real schemas have and the demo seed doesn't: a role-scoped RLS policy, a
// partitioned table, and names that are Postgres keywords. Real Docker, like shadow.test.ts.
const DB = "dg_test_shadow_edge";
const targetUrl = withDatabase(TARGET_RO_URL, DB);

const read = async (): Promise<Schema> => {
  const pool = createPool(targetUrl, { statementTimeoutMs: 60_000 });
  try {
    return await introspect(pool);
  } finally {
    await pool.end();
  }
};

let source: Schema;
let target: Schema;

beforeAll(async () => {
  await createScratchDatabase(TARGET_ADMIN_URL, DB);
  // On the target already: a policy for a named role (a schema dump has no roles) and a
  // partitioned table (its parent and partitions each need the plan role as owner).
  await runAsAdmin(TARGET_ADMIN_URL, DB, `
    CREATE POLICY accounts_ro ON accounts FOR SELECT TO pgvouch_ro USING (true);
    CREATE TABLE events (id int, at date, PRIMARY KEY (id, at)) PARTITION BY RANGE (at);
    CREATE TABLE events_2024 PARTITION OF events FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
    GRANT SELECT ON events, events_2024 TO pgvouch_ro;
  `);
  target = await read();
  // The desired state adds a view over the partitioned table and a table whose names are
  // keywords. Created briefly so the source schema carries Postgres' own definitions.
  await runAsAdmin(TARGET_ADMIN_URL, DB, `
    CREATE VIEW events_per_day AS SELECT at, count(*) AS n FROM events GROUP BY at;
    CREATE TABLE "window" ("case" int PRIMARY KEY, "current_date" date, "binary" text);
    CREATE INDEX "verbose" ON "window" ("binary");
  `);
  source = await read();
  await runAsAdmin(TARGET_ADMIN_URL, DB, `DROP VIEW events_per_day; DROP TABLE "window";`);
}, 120_000);

afterAll(async () => {
  await dropScratchDatabase(TARGET_ADMIN_URL, DB);
});

describe("shadow runs on real-world schema shapes", () => {
  it("copies a target with role-scoped policies and plans a view over a partitioned table and keyword names", async () => {
    const drift = diffSchemas(source, target);
    expect(drift.items.map(driftItemKey).sort()).toEqual(["table_missing:public.window", "view_missing:public.events_per_day"]);

    const plan = await planMigration({ drift, source, target });
    const report = await shadowRun({ targetUrl, source, plan });

    expect(report.steps.map((s) => [s.title, s.status])).toEqual([
      ["Create table public.window", "applied"],
      ["Create index verbose", "applied"],
      ["Create view public.events_per_day", "applied"],
    ]);
    expect(report.verdict).toBe("pass");
  }, 180_000);
});
