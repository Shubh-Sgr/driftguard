import { describe, expect, it } from "vitest";
import { diffSchemas } from "../../src/diff/diff.js";
import { LlmError, type LlmProvider } from "../../src/llm/provider.js";
import { limitFeedback, MAX_FEEDBACK_CHARS, MAX_FEEDBACK_ERRORS, planMigration } from "../../src/plan/plan.js";
import { acceptanceNote, renderPlanSql } from "../../src/plan/render.js";
import type { MigrationPlan, PlanVerdict, PlanVerifier } from "../../src/plan/types.js";
import { validatePlanSql } from "../../src/plan/validate.js";
import { clone, col, schema, table } from "../helpers/schema.js";

const source = schema(
  table("accounts", [col("id", "bigint", { nullable: false }), col("status", "text", { nullable: false }), col("region", "text")], {
    estimatedRows: 20_000,
    primaryKey: ["id"],
  }),
);
// Target is missing `region` and has an extra column `legacy`.
const target = clone(source);
delete target.tables["public.accounts"]!.columns.region;
target.tables["public.accounts"]!.columns.legacy = col("legacy", "integer");
const drift = diffSchemas(source, target);

/** A fake LLM that returns canned responses in order and records the prompts it got. */
function fakeLlm(...responses: (string | Error)[]): LlmProvider & { calls: number; prompts: string[] } {
  return {
    id: "fake:test",
    calls: 0,
    prompts: [],
    async complete({ prompt }) {
      this.prompts.push(prompt);
      const r = responses[this.calls++]!;
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

/** A fake verifier (stands in for the shadow run) that returns canned verdicts in order. */
function fakeVerifier(...verdicts: PlanVerdict[]): PlanVerifier & { plans: MigrationPlan[] } {
  const plans: MigrationPlan[] = [];
  return Object.assign(async (p: MigrationPlan) => {
    plans.push(p);
    return verdicts[plans.length - 1]!;
  }, { plans });
}
const plan = (steps: { sql: string }[]) => JSON.stringify({ summary: "s", steps: steps.map((s, i) => ({ title: `t${i}`, rationale: "r", ...s })) });

describe("guardrail validator", () => {
  it("accepts a safe plan that only references real objects", async () => {
    const r = await validatePlanSql([{ sql: "ALTER TABLE accounts ADD COLUMN region text" }, { sql: "CREATE INDEX CONCURRENTLY accounts_region_idx ON accounts (region)" }], target);
    expect(r).toEqual({ valid: true, errors: [] });
  });

  it("rejects hallucinated tables and columns", async () => {
    const r = await validatePlanSql([{ sql: "ALTER TABLE acounts ADD COLUMN region text" }, { sql: "CREATE INDEX CONCURRENTLY i ON accounts (regoin)" }], target);
    expect(r.errors).toEqual(["step 1: table public.acounts does not exist", "step 2: column public.accounts.regoin does not exist"]);
  });

  it("lets later steps use objects created by earlier steps", async () => {
    const r = await validatePlanSql([
      { sql: "ALTER TABLE accounts ADD COLUMN region text" },
      { sql: "ALTER TABLE accounts ADD CONSTRAINT region_nn CHECK (region IS NOT NULL) NOT VALID" },
      { sql: "ALTER TABLE accounts VALIDATE CONSTRAINT region_nn" },
      { sql: "ALTER TABLE accounts ALTER COLUMN region SET NOT NULL" },
    ], target);
    expect(r.errors).toEqual([]);
  });

  it("rejects risky statements that have a known safe rewrite", async () => {
    const r = await validatePlanSql([{ sql: "CREATE INDEX i ON accounts (status)" }, { sql: "ALTER TABLE accounts ALTER COLUMN status SET NOT NULL" }], target);
    expect(r.errors.join("\n")).toMatch(/create_index_concurrently/);
    expect(r.errors.join("\n")).toMatch(/set_not_null_via_check/);
  });

  it("rejects statements outside the allow-list and WHERE-less UPDATEs", async () => {
    const r = await validatePlanSql([{ sql: "BEGIN" }, { sql: "DELETE FROM accounts" }, { sql: "UPDATE accounts SET status = 'x'" }, { sql: "DO $$ BEGIN END $$" }], target);
    expect(r.errors).toEqual([
      "step 1: TransactionStmt is not allowed in a migration plan",
      "step 2: DeleteStmt is not allowed in a migration plan",
      "step 3: UPDATE without WHERE is not allowed; backfill in primary-key ranges",
      "step 4: DoStmt is not allowed in a migration plan",
    ]);
  });

  it("only allows DROP INDEX and DROP TABLE, not DROP SCHEMA / VIEW / FUNCTION", async () => {
    const r = await validatePlanSql([
      { sql: "DROP SCHEMA public CASCADE" },
      { sql: "DROP VIEW v" },
      { sql: "DROP FUNCTION f()" },
      { sql: "DROP INDEX CONCURRENTLY IF EXISTS accounts_region_idx" },
      { sql: "DROP TABLE IF EXISTS old_stuff" },
    ], target);
    expect(r.errors).toEqual([
      "step 1: DROP SCHEMA is not allowed in a migration plan",
      "step 2: DROP VIEW is not allowed in a migration plan",
      "step 3: DROP FUNCTION is not allowed in a migration plan",
    ]);
  });

  it("reports SQL that doesn't parse", async () => {
    const r = await validatePlanSql([{ sql: "ALTER TABLE accounts ADD COLUM x int" }], target);
    expect(r.errors[0]).toMatch(/does not parse/);
  });
});

describe("planMigration", () => {
  it("builds a rules-only plan without an LLM, keeping data-lossy steps in the contract phase", async () => {
    const p = await planMigration({ drift, source, target });
    expect(p).toMatchObject({ author: "rules", acceptedBy: null, fellBack: false, fallbackReason: null });
    expect(p.steps.map((s) => [s.sql, s.phase])).toEqual([
      ["ALTER TABLE accounts ADD COLUMN region text", "expand"],
      ["ALTER TABLE accounts DROP COLUMN legacy", "contract"],
    ]);
    expect(renderPlanSql(p)).toContain("-- ALTER TABLE accounts DROP COLUMN legacy;"); // commented out by default
    expect(renderPlanSql(p, { allowDataLoss: true })).toContain("\nALTER TABLE accounts DROP COLUMN legacy;");
  });

  it("uses a valid LLM plan, but computes risk and reversibility itself", async () => {
    const llm = fakeLlm(plan([{ sql: "ALTER TABLE accounts ADD COLUMN region text" }]));
    const p = await planMigration({ drift, source, target, llm });
    // No verifier: accepted on the validator alone, and the output says so.
    expect(p).toMatchObject({ author: "llm", model: "fake:test", fellBack: false, acceptedBy: "validator" });
    expect(renderPlanSql(p)).toContain("WARNING: accepted by the guardrail validator only");
    expect(p.steps[0]).toMatchObject({ risk: "low", reversibility: "reversible", rollbackSql: "ALTER TABLE accounts DROP COLUMN region" });
  });

  it("retries once with the validator's errors, then accepts a fixed plan", async () => {
    const llm = fakeLlm(plan([{ sql: "ALTER TABLE acounts ADD COLUMN region text" }]), plan([{ sql: "ALTER TABLE accounts ADD COLUMN region text" }]));
    const p = await planMigration({ drift, source, target, llm });
    expect(llm.calls).toBe(2);
    expect(p.author).toBe("llm");
    expect(p.attempts.map((a) => a.valid)).toEqual([false, true]);
  });

  it("falls back to the rules-only plan when both attempts are invalid", async () => {
    const llm = fakeLlm("not json", plan([{ sql: "TRUNCATE accounts" }]));
    const p = await planMigration({ drift, source, target, llm });
    expect(p).toMatchObject({ author: "rules", fellBack: true });
    expect(p.attempts[0]!.errors[0]).toMatch(/response shape/);
    expect(p.attempts[1]!.errors[0]).toMatch(/TruncateStmt is not allowed/);
  });

  it("falls back (without crashing) when the LLM is unreachable", async () => {
    const p = await planMigration({ drift, source, target, llm: fakeLlm(new LlmError("connection refused")) });
    expect(p).toMatchObject({ author: "rules", fellBack: true, fallbackReason: "LLM unavailable: connection refused" });
    expect(p.attempts[0]!.stage).toBe("llm");
  });

  it("accepts an LLM plan only after the shadow run passes, retrying with the shadow's errors", async () => {
    const incomplete = plan([{ sql: "ALTER TABLE accounts ADD COLUMN region text" }]);
    const complete = plan([{ sql: "ALTER TABLE accounts ADD COLUMN region text" }, { sql: "ALTER TABLE accounts DROP COLUMN legacy" }]);
    const llm = fakeLlm(incomplete, complete);
    const verify = fakeVerifier({ ok: false, errors: ["after applying the plan, column public.accounts.legacy (integer) exists only on target"] }, { ok: true });

    const p = await planMigration({ drift, source, target, llm, verify });

    expect(p).toMatchObject({ author: "llm", acceptedBy: "validator+shadow", fellBack: false, fallbackReason: null });
    expect(p.steps).toHaveLength(2);
    expect(p.attempts.map((a) => [a.valid, a.stage])).toEqual([[false, "shadow"], [true, "shadow"]]);
    // The retry prompt carries the shadow's finding, so the LLM knows what to fix.
    expect(llm.prompts[1]).toContain("column public.accounts.legacy (integer) exists only on target");
    // The verifier gets the finalized plan (PgVouch's own phase/risk), not raw LLM JSON.
    expect(verify.plans[1]!.steps[1]).toMatchObject({ phase: "contract", reversibility: "data-lossy" });
    expect(acceptanceNote(p)).toMatch(/AND a passing shadow run/);
  });

  it("falls back to the rules plan when the shadow run keeps failing", async () => {
    const valid = plan([{ sql: "ALTER TABLE accounts ADD COLUMN region text" }]);
    const verify = fakeVerifier({ ok: false, errors: ["e1"] }, { ok: false, errors: ["e2"] });
    const p = await planMigration({ drift, source, target, llm: fakeLlm(valid, valid), verify });
    expect(p).toMatchObject({ author: "rules", fellBack: true, acceptedBy: null });
    expect(p.fallbackReason).toMatch(/2 attempt\(s\); the last one failed the shadow run/);
  });

  it("does not retry the LLM when the shadow run is unavailable, and does not accept an unproven plan", async () => {
    const llm = fakeLlm(plan([{ sql: "ALTER TABLE accounts ADD COLUMN region text" }]), plan([{ sql: "unused" }]));
    const verify = fakeVerifier({ unavailable: "could not start a shadow container (is Docker running?)" });
    const p = await planMigration({ drift, source, target, llm, verify });
    expect(llm.calls).toBe(1);
    expect(p).toMatchObject({ author: "rules", fellBack: true, acceptedBy: null });
    expect(p.fallbackReason).toMatch(/shadow run unavailable.*is Docker running/);
    expect(renderPlanSql(p)).toContain("The LLM plan was not used: shadow run unavailable");
  });

  it("never shadow-runs a plan the validator rejected", async () => {
    const verify = fakeVerifier();
    const llm = fakeLlm(plan([{ sql: "TRUNCATE accounts" }]), plan([{ sql: "ALTER TABLE nope ADD COLUMN x int" }]));
    const p = await planMigration({ drift, source, target, llm, verify });
    expect(verify.plans).toHaveLength(0);
    expect(p.attempts.map((a) => a.stage)).toEqual(["validator", "validator"]);
    expect(p.fallbackReason).toMatch(/failed the validator/);
  });

  it("caps the feedback sent back to the LLM", async () => {
    const errors = Array.from({ length: 15 }, (_, i) => `problem ${i} ${"x".repeat(1000)}`);
    const limited = limitFeedback(errors);
    expect(limited).toHaveLength(MAX_FEEDBACK_ERRORS + 1);
    expect(limited.slice(0, -1).every((e) => e.length === MAX_FEEDBACK_CHARS && e.endsWith("..."))).toBe(true);
    expect(limited.at(-1)).toBe("(5 more problem(s) not shown)");
    expect(limitFeedback(["short"])).toEqual(["short"]);

    // End to end: the retry prompt holds the capped list, not all 15 kB of errors.
    const llm = fakeLlm(plan([{ sql: "ALTER TABLE accounts ADD COLUMN region text" }]), "not json");
    await planMigration({ drift, source, target, llm, verify: fakeVerifier({ ok: false, errors }) });
    expect(llm.prompts[1]).toContain("problem 9 ");
    expect(llm.prompts[1]).not.toContain("problem 10 ");
    expect(llm.prompts[1]!.length - llm.prompts[0]!.length).toBeLessThan(4000);
  });

  it("does not call the LLM when there is no drift", async () => {
    const llm = fakeLlm();
    const p = await planMigration({ drift: diffSchemas(source, source), source, target: source, llm });
    expect(llm.calls).toBe(0);
    expect(p.steps).toEqual([]);
  });
});
