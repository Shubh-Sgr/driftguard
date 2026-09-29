import pg from "pg";
import { diffSchemas } from "../diff/diff.js";
import type { DriftItem, DriftReport } from "../diff/types.js";
import { introspect } from "../introspect/introspect.js";
import type { Schema } from "../introspect/types.js";
import type { MigrationPlan } from "../plan/types.js";
import { parseSql } from "../sql/parse.js";
import { copySchemaInto, startShadowContainer } from "./docker.js";

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
}

// Drift left over on purpose: we skip data-lossy contract steps by default and never
// run manual steps, so these kinds may remain without the plan being wrong.
const EXPECTED_IF_CONTRACT_SKIPPED = new Set<DriftItem["kind"]>(["table_extra", "column_extra", "sequence_extra"]);
const ALWAYS_MANUAL = new Set<DriftItem["kind"]>(["primary_key_changed", "possible_rename"]);

/**
 * F10: proves a plan works before it touches a real database.
 * 1. Start a throwaway Postgres container.
 * 2. Copy the TARGET's schema into it (schema only — no data leaves the target).
 * 3. Apply the plan step by step, exactly as a human would run it.
 * 4. Introspect the result and diff it against SOURCE: it should now match.
 * The container is always removed afterwards.
 */
export async function shadowRun(opts: ShadowOptions): Promise<ShadowReport> {
  const started = Date.now();
  const container = await startShadowContainer(opts.image);
  try {
    await waitForPostgres(container.url);
    await copySchemaInto(container, opts.targetUrl);

    // This connection writes, but only to the disposable shadow database.
    const client = new pg.Client({ connectionString: container.url });
    await client.connect();
    const steps: ShadowStepResult[] = [];
    let failed = false;
    let shadowSchema: Schema;
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
      shadowSchema = await introspect(client);
    } finally {
      await client.end();
    }

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
    await container.remove();
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
