import { randomBytes } from "node:crypto";
import pg from "pg";
import { diffSchemas } from "../diff/diff.js";
import type { DriftItem, DriftReport } from "../diff/types.js";
import { introspect } from "../introspect/introspect.js";
import type { Schema } from "../introspect/types.js";
import type { MigrationPlan } from "../plan/types.js";
import { parseSql } from "../sql/parse.js";
import { copySchemaInto, startShadowContainer, type ShadowContainer } from "./docker.js";

export interface ShadowStepResult {
  step: number;
  title: string;
  status: "applied" | "skipped" | "failed";
  reason?: string;
  ms?: number;
}

export interface ShadowReport {
  /** pass = every step applied cleanly AND the result matches the source schema. */
  verdict: "pass" | "fail";
  steps: ShadowStepResult[];
  /** Drift between SOURCE and the shadow AFTER applying the plan. */
  remainingDrift: DriftReport;
  /** Remaining drift that is expected (skipped contract/manual steps), so doesn't fail the run. */
  expectedRemaining: DriftItem[];
  elapsedMs: number;
}

export interface ShadowOptions {
  /** Read-only URL of the database the plan is for; only its SCHEMA is copied. */
  targetUrl: string;
  /** The desired end state. */
  source: Schema;
  plan: MigrationPlan;
  /** Also apply contract (data-lossy) steps in the shadow. */
  allowDataLoss?: boolean;
  image?: string;
  /** Hard cap per statement, enforced client-side so plan SQL can't lift it. */
  statementTimeoutMs?: number;
}

/**
 * The shadow could not be run at all (Docker missing, image pull failed, target
 * unreachable, ...). This says nothing about whether the PLAN is right, so callers
 * must not treat it as a plan failure.
 */
export class ShadowUnavailableError extends Error {}

// Drift left over on purpose: we skip data-lossy contract steps by default and never
// run manual steps, so these kinds may remain without the plan being wrong.
const EXPECTED_IF_CONTRACT_SKIPPED = new Set<DriftItem["kind"]>([
  "table_extra", "column_extra", "sequence_extra",
  "view_extra", "function_extra", "trigger_extra", "policy_extra", "enum_extra",
]);
// Extensions need a privileged role, so the plan leaves them to a human.
const ALWAYS_MANUAL = new Set<DriftItem["kind"]>([
  "primary_key_changed", "possible_rename",
  "extension_missing", "extension_extra", "extension_changed",
]);

// The role that runs plan SQL. Not a superuser: it can change the tables it owns, but it
// can't read files, run programs (COPY ... PROGRAM) or change server settings, even if
// a plan contains something hostile like pg_read_file().
const PLAN_ROLE = "pgvouch_plan_runner";

/**
 * F10: proves a plan works before it touches a real database.
 * 1. Start a throwaway Postgres container.
 * 2. Copy the TARGET's schema into it (schema only — no data leaves the target).
 * 3. Hand ownership of the copied objects to a non-superuser role.
 * 4. Apply the plan step by step as that role, exactly as a human would run it.
 * 5. Introspect the result and diff it against SOURCE: it should now match.
 * The container is always removed afterwards, including on Ctrl-C.
 */
export async function shadowRun(opts: ShadowOptions): Promise<ShadowReport> {
  const started = Date.now();
  const container = await unavailableOnError("could not start a shadow container (is Docker running?)", async () =>
    startShadowContainer(opts.image ?? (await imageForTarget(opts.targetUrl))),
  );

  // If the process is interrupted, still remove the container (async cleanup wouldn't finish).
  const onSignal = (signal: NodeJS.Signals) => {
    container.removeSync();
    process.kill(process.pid, signal);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const planRolePassword = await unavailableOnError("could not prepare the shadow database", async () => {
      await waitForPostgres(container.superuserUrl);
      await copySchemaInto(container, opts.targetUrl);
      return createPlanRole(container);
    });

    const steps = await applyPlan(container.urlFor(PLAN_ROLE, planRolePassword), opts);
    const failed = steps.some((s) => s.status === "failed");

    const shadowSchema = await unavailableOnError("could not read the shadow schema", () => introspectUrl(container.superuserUrl));
    const remainingDrift = diffSchemas(opts.source, shadowSchema);
    const expectedRemaining = remainingDrift.items.filter(
      (i) => ALWAYS_MANUAL.has(i.kind) || (!opts.allowDataLoss && EXPECTED_IF_CONTRACT_SKIPPED.has(i.kind)),
    );
    const unexpected = remainingDrift.items.length - expectedRemaining.length;

    return {
      verdict: !failed && unexpected === 0 ? "pass" : "fail",
      steps,
      remainingDrift,
      expectedRemaining,
      elapsedMs: Date.now() - started,
    };
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await container.remove();
  }
}

async function applyPlan(url: string, opts: ShadowOptions): Promise<ShadowStepResult[]> {
  // query_timeout is enforced by the client library, so a plan that runs
  // SET statement_timeout = 0 still can't hang the run.
  const client = new pg.Client({ connectionString: url, query_timeout: opts.statementTimeoutMs ?? 60_000 });
  await unavailableOnError("could not connect to the shadow database", () => client.connect());
  const steps: ShadowStepResult[] = [];
  let failed = false;
  try {
    for (const [i, step] of opts.plan.steps.entries()) {
      const base = { step: i + 1, title: step.title };
      if (failed) {
        steps.push({ ...base, status: "skipped", reason: "an earlier step failed" });
      } else if (step.manual) {
        steps.push({ ...base, status: "skipped", reason: "manual step" });
      } else if (step.phase === "contract" && !opts.allowDataLoss) {
        steps.push({ ...base, status: "skipped", reason: "contract (data-lossy) step; pass allowDataLoss to include" });
      } else {
        const t0 = Date.now();
        try {
          // One statement per query: a multi-statement query runs as one implicit
          // transaction, where CONCURRENTLY and COMMIT-in-DO are not allowed.
          for (const stmt of await parseSql(step.sql)) await client.query(stmt.text);
          steps.push({ ...base, status: "applied", ms: Date.now() - t0 });
        } catch (err) {
          failed = true;
          steps.push({ ...base, status: "failed", reason: (err as Error).message, ms: Date.now() - t0 });
        }
      }
    }
  } finally {
    // A timed-out query can leave the client unusable; ending may itself fail.
    await client.end().catch(() => undefined);
  }
  return steps;
}

/**
 * Creates the non-superuser plan role and gives it ownership of every copied schema
 * and table (ALTER TABLE needs ownership). Sequences owned by a column follow their
 * table automatically, so only standalone sequences are changed directly.
 */
async function createPlanRole(container: ShadowContainer): Promise<string> {
  const password = randomBytes(12).toString("hex");
  const admin = new pg.Client({ connectionString: container.superuserUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE ROLE ${PLAN_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);
    await admin.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT nspname FROM pg_namespace
                 WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' LOOP
          EXECUTE format('ALTER SCHEMA %I OWNER TO ${PLAN_ROLE}', r.nspname);
        END LOOP;
        FOR r IN SELECT n.nspname, c.relname, c.relkind
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
                   AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
                   AND NOT EXISTS (SELECT 1 FROM pg_depend d
                                   WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                                     AND d.deptype IN ('a', 'i')) LOOP
          EXECUTE format('ALTER %s %I.%I OWNER TO ${PLAN_ROLE}',
            CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW'
                           WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE'
                           ELSE 'TABLE' END,
            r.nspname, r.relname);
        END LOOP;
        -- Functions and standalone types too, or CREATE OR REPLACE FUNCTION and
        -- ALTER TYPE ... ADD VALUE fail with "must be owner". Objects that belong to an
        -- extension stay with it (the plan never changes those).
        FOR r IN SELECT p.oid::regprocedure AS sig, p.prokind
                 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
                   AND p.prokind IN ('f', 'p')
                   AND NOT EXISTS (SELECT 1 FROM pg_depend d
                                   WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e') LOOP
          EXECUTE format('ALTER %s %s OWNER TO ${PLAN_ROLE}',
            CASE r.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, r.sig);
        END LOOP;
        FOR r IN SELECT t.oid::regtype AS typ, t.typtype
                 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
                   AND t.typtype IN ('e', 'd', 'r')
                   AND NOT EXISTS (SELECT 1 FROM pg_depend d
                                   WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e') LOOP
          EXECUTE format('ALTER %s %s OWNER TO ${PLAN_ROLE}',
            CASE r.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, r.typ);
        END LOOP;
      END $$`);
  } finally {
    await admin.end();
  }
  return password;
}

async function unavailableOnError<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new ShadowUnavailableError(`${what}: ${(err as Error).message}`);
  }
}

/**
 * The shadow must run the target's MAJOR version: a pg_dump older than the server refuses
 * to dump it (16 can't dump 17), and plan SQL should meet the same Postgres as production.
 */
async function imageForTarget(targetUrl: string): Promise<string> {
  const client = new pg.Client({ connectionString: targetUrl });
  try {
    await client.connect();
    const { rows } = await client.query<{ v: string }>("SELECT current_setting('server_version_num') AS v");
    const major = Math.floor(Number(rows[0]?.v) / 10_000);
    return Number.isInteger(major) && major >= 10 ? `postgres:${major}-alpine` : "postgres:16-alpine";
  } catch {
    return "postgres:16-alpine"; // copying the schema will report the real problem
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** The official image restarts once after init; retry until the real server accepts TCP. */
async function waitForPostgres(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (err) {
      await client.end().catch(() => undefined);
      if (Date.now() > deadline) throw new Error(`shadow database did not start: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function introspectUrl(url: string): Promise<Schema> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await introspect(client);
  } finally {
    await client.end();
  }
}
