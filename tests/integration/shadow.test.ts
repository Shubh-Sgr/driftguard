import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db.js";
import { diffSchemas } from "../../src/diff/diff.js";
import type { DriftReport } from "../../src/diff/types.js";
import { introspect } from "../../src/introspect/introspect.js";
import type { Schema } from "../../src/introspect/types.js";
import type { LlmProvider } from "../../src/llm/provider.js";
import { planMigration } from "../../src/plan/plan.js";
import { validatePlanSql } from "../../src/plan/validate.js";
import { shadowVerifier } from "../../src/shadow/verifier.js";
import { createScratchDatabase, dropScratchDatabase, runAsAdmin, withDatabase } from "../../evals/lib/scratch.js";
import { SOURCE_RO_URL, TARGET_ADMIN_URL, TARGET_RO_URL } from "./env.js";

// Real Docker: each verification starts a disposable Postgres container, copies the
// scratch target's schema into it and applies the plan there.
const DB = "dg_test_shadow";
const targetUrl = withDatabase(TARGET_RO_URL, DB);

let source: Schema;
let target: Schema;
let drift: DriftReport;

beforeAll(async () => {
  await createScratchDatabase(TARGET_ADMIN_URL, DB);
  // Two drift items: a missing index and an extra column.
  await runAsAdmin(TARGET_ADMIN_URL, DB, `
    DROP INDEX transactions_account_created_idx;
    ALTER TABLE accounts ADD COLUMN legacy_code int;
  `);
  const sourcePool = createPool(SOURCE_RO_URL, { statementTimeoutMs: 60_000 });
  const targetPool = createPool(targetUrl, { statementTimeoutMs: 60_000 });
  try {
    [source, target] = await Promise.all([introspect(sourcePool), introspect(targetPool)]);
  } finally {
    await Promise.all([sourcePool.end(), targetPool.end()]);
  }
  drift = diffSchemas(source, target);
});

afterAll(async () => {
  await dropScratchDatabase(TARGET_ADMIN_URL, DB);
});

/** A scripted "LLM" that returns these plans in order. */
function scriptedLlm(...plans: string[][]): LlmProvider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    id: "scripted:test",
    prompts,
    async complete({ prompt }) {
      const steps = plans[prompts.length]!;
      prompts.push(prompt);
      return JSON.stringify({ summary: "s", steps: steps.map((sql, i) => ({ title: `step ${i + 1}`, sql, rationale: "r" })) });
    },
  };
}

const CREATE_INDEX = "CREATE INDEX CONCURRENTLY transactions_account_created_idx ON transactions (account_id, created_at)";
const DROP_COLUMN = "ALTER TABLE accounts DROP COLUMN legacy_code";

describe("shadow-verified LLM plans (F7 + F10)", () => {
  it("rejects a valid but incomplete plan, then accepts the corrected one", async () => {
    expect(drift.items.map((i) => i.kind).sort()).toEqual(["column_extra", "index_missing"]);
    const llm = scriptedLlm([CREATE_INDEX], [CREATE_INDEX, DROP_COLUMN]);

    const plan = await planMigration({ drift, source, target, llm, verify: shadowVerifier({ targetUrl, source }) });

    // Attempt 1 passed the validator (it is safe) but the shadow showed it is incomplete.
    expect(plan.attempts.map((a) => [a.valid, a.stage])).toEqual([[false, "shadow"], [true, "shadow"]]);
    expect(plan.attempts[0]!.errors).toEqual(["after applying the plan, column public.accounts.legacy_code (integer) exists only on target"]);
    expect(llm.prompts[1]).toContain("legacy_code (integer) exists only on target");
    expect(plan).toMatchObject({ author: "llm", acceptedBy: "validator+shadow", fellBack: false });
  });

  it("least privilege: a hostile plan passes the validator but fails in the shadow", async () => {
    const hostile = [CREATE_INDEX, "UPDATE accounts SET status = pg_read_file('/etc/passwd') WHERE id = 1", DROP_COLUMN];
    // The validator only checks structure and safety rules, so this gets through it...
    expect(await validatePlanSql(hostile.map((sql) => ({ sql })), target)).toEqual({ valid: true, errors: [] });

    // ...but plan SQL runs as a non-superuser in the shadow, so reading a server file fails.
    const plan = await planMigration({ drift, source, target, llm: scriptedLlm(hostile), verify: shadowVerifier({ targetUrl, source }), maxAttempts: 1 });
    expect(plan.attempts[0]).toMatchObject({ valid: false, stage: "shadow" });
    expect(plan.attempts[0]!.errors[0]).toMatch(/step 2 .*permission denied for function pg_read_file/);
    expect(plan).toMatchObject({ author: "rules", fellBack: true, acceptedBy: null });
  });

  it("reports 'unavailable' (not a plan failure) when the shadow can't copy the target", async () => {
    // Nothing listens on port 1, so the schema copy fails before any plan SQL runs.
    const verify = shadowVerifier({ targetUrl: "postgres://driftguard_ro:x@127.0.0.1:1/fintech", source });
    const llm = scriptedLlm([CREATE_INDEX, DROP_COLUMN], [CREATE_INDEX, DROP_COLUMN]);
    const plan = await planMigration({ drift, source, target, llm, verify });
    expect(llm.prompts).toHaveLength(1); // no pointless retry
    expect(plan).toMatchObject({ author: "rules", fellBack: true, acceptedBy: null });
    expect(plan.fallbackReason).toMatch(/^shadow run unavailable, LLM plan not proven: could not prepare the shadow database/);
  });
});
