import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { createPool } from "../../src/db.js";
import { diffSchemas } from "../../src/diff/diff.js";
import { driftItemKey } from "../../src/diff/types.js";
import { introspect } from "../../src/introspect/introspect.js";
import type { Schema } from "../../src/introspect/types.js";
import type { LlmProvider } from "../../src/llm/provider.js";
import { planMigration } from "../../src/plan/plan.js";
import type { MigrationPlan } from "../../src/plan/types.js";
import { shadowRun } from "../../src/shadow/shadow.js";
import { quoteIdent } from "../../src/sql/ident.js";
import { verifyData } from "../../src/verify/verify.js";
import { createScratchDatabase, dropScratchDatabase, runAsAdmin, TARGET_ADMIN_URL, TARGET_RO_URL, withDatabase } from "./scratch.js";

interface Expected {
  description: string;
  drift: string[];
  /** table -> expected differences; "*" = verify every table, expect none. */
  data?: Record<string, { rows?: { kind: string; key: Record<string, string> }[]; localized?: boolean }>;
}

export interface PlanOutcome {
  author: MigrationPlan["author"];
  fellBack: boolean;
  attempts: { valid: boolean; errors: string[] }[];
  steps: number;
  shadow: "pass" | "fail" | "not run";
  shadowFailure?: string;
}

export interface ScenarioResult {
  name: string;
  description: string;
  drift: { tp: number; fp: number; fn: number; falsePositives: string[]; missed: string[] };
  data?: {
    tablesTp: number;
    tablesFp: number;
    tablesFn: number;
    rowsExpected: number;
    rowsFound: number;
    rowsFalse: number;
    /** Rows fetched by bisection vs rows in the mismatched tables (both sides). */
    rowsFetched: number;
    rowsInMismatchedTables: number;
    hashQueries: number;
    verifyMs: number;
  };
  rulesPlan?: PlanOutcome;
  llmPlan?: PlanOutcome;
}

/** Runs every scenario in evals/scenarios against a fresh scratch copy of the target. */
export async function runScenarios(dir: string, source: pg.Pool, sourceSchema: Schema, llm?: LlmProvider, log = console.log): Promise<ScenarioResult[]> {
  const names = (await readdir(dir)).filter((n) => !n.startsWith(".")).sort();
  const results: ScenarioResult[] = [];

  for (const name of names) {
    const expected = JSON.parse(await readFile(path.join(dir, name, "expected.json"), "utf8")) as Expected;
    const setup = await readFile(path.join(dir, name, "setup.sql"), "utf8");
    const db = `eval_${name}`;
    log(`[scenario] ${name}`);

    await createScratchDatabase(TARGET_ADMIN_URL, db);
    const targetUrl = withDatabase(TARGET_RO_URL, db);
    const target = createPool(targetUrl, { statementTimeoutMs: 120_000 });
    try {
      await runAsAdmin(TARGET_ADMIN_URL, db, setup.replaceAll(":db", quoteIdent(db)));
      const targetSchema = await introspect(target);
      const drift = diffSchemas(sourceSchema, targetSchema);

      // possible_rename is an advisory hint, not a claim of drift, so it's not scored.
      const found = new Set(drift.items.filter((i) => i.kind !== "possible_rename").map(driftItemKey));
      const want = new Set(expected.drift);
      const result: ScenarioResult = {
        name,
        description: expected.description,
        drift: {
          tp: [...found].filter((k) => want.has(k)).length,
          fp: [...found].filter((k) => !want.has(k)).length,
          fn: [...want].filter((k) => !found.has(k)).length,
          falsePositives: [...found].filter((k) => !want.has(k)),
          missed: [...want].filter((k) => !found.has(k)),
        },
      };

      if (expected.data) result.data = await scoreData(source, target, expected.data);

      if (!drift.identical) {
        const rules = await planMigration({ drift, source: sourceSchema, target: targetSchema });
        result.rulesPlan = await shadowOutcome(rules, targetUrl, sourceSchema);
        if (llm) {
          log(`  asking ${llm.id} for a plan...`);
          const plan = await planMigration({ drift, source: sourceSchema, target: targetSchema, llm });
          // Only shadow-run plans the LLM actually wrote; fallbacks are the rules plan above.
          result.llmPlan = plan.author === "llm" ? await shadowOutcome(plan, targetUrl, sourceSchema) : { ...summarizePlan(plan), shadow: "not run" };
        }
      }
      results.push(result);
    } finally {
      await target.end();
      await dropScratchDatabase(TARGET_ADMIN_URL, db);
    }
  }
  return results;
}

async function scoreData(source: pg.Pool, target: pg.Pool, expected: NonNullable<Expected["data"]>): Promise<NonNullable<ScenarioResult["data"]>> {
  const all = "*" in expected;
  const report = await verifyData(source, target, { tables: all ? undefined : Object.keys(expected), findRows: true, maxRows: 1000 });
  const score = { tablesTp: 0, tablesFp: 0, tablesFn: 0, rowsExpected: 0, rowsFound: 0, rowsFalse: 0, rowsFetched: 0, rowsInMismatchedTables: 0, hashQueries: 0, verifyMs: report.elapsedMs };

  for (const t of report.tables) {
    const exp = expected[t.table];
    const shouldMismatch = !!exp && (!!exp.rows?.length || exp.localized === false);
    const detected = t.status === "mismatch";
    if (detected && shouldMismatch) score.tablesTp++;
    else if (detected) score.tablesFp++;
    else if (shouldMismatch) score.tablesFn++;

    const wantRows = new Set((exp?.rows ?? []).map((r) => JSON.stringify([r.kind, r.key])));
    const gotRows = (t.differingRows ?? []).map((r) => JSON.stringify([r.kind, r.key]));
    score.rowsExpected += wantRows.size;
    score.rowsFound += gotRows.filter((r) => wantRows.has(r)).length;
    score.rowsFalse += gotRows.filter((r) => !wantRows.has(r)).length;
    if (detected && t.bisect) {
      score.rowsFetched += t.bisect.rowsFetched;
      score.hashQueries += t.bisect.hashQueries;
      score.rowsInMismatchedTables += t.sourceRows + t.targetRows;
    }
  }
  return score;
}

function summarizePlan(plan: MigrationPlan): Omit<PlanOutcome, "shadow"> {
  return { author: plan.author, fellBack: plan.fellBack, attempts: plan.attempts.map(({ valid, errors }) => ({ valid, errors })), steps: plan.steps.length };
}

async function shadowOutcome(plan: MigrationPlan, targetUrl: string, source: Schema): Promise<PlanOutcome> {
  const report = await shadowRun({ targetUrl, source, plan });
  const failedStep = report.steps.find((s) => s.status === "failed");
  const unexpected = report.remainingDrift.items.filter((i) => !report.expectedRemaining.includes(i)).map(driftItemKey);
  return {
    ...summarizePlan(plan),
    shadow: report.verdict,
    shadowFailure: failedStep ? `step ${failedStep.step}: ${failedStep.reason}` : unexpected.length ? `remaining drift: ${unexpected.join(", ")}` : undefined,
  };
}
