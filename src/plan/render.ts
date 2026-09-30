import type { MigrationPlan } from "./types.js";

export interface RenderOptions {
  lockTimeout?: string;
  statementTimeout?: string;
  /** Contract (data-lossy) steps are commented out unless this is set. */
  allowDataLoss?: boolean;
}

/** Renders a plan as a SQL script a human reviews and runs. PgVouch never runs it. */
export function renderPlanSql(plan: MigrationPlan, opts: RenderOptions = {}): string {
  const lines = [
    `-- PgVouch migration plan (${plan.author === "llm" ? `LLM: ${plan.model}` : "rules-only"})`,
    `-- ${acceptanceNote(plan)}`,
    `-- ${plan.summary}`,
    "-- Review every step. Steps marked 'outside a transaction' must not be wrapped in BEGIN/COMMIT.",
    `SET lock_timeout = '${opts.lockTimeout ?? "3s"}';`,
    `SET statement_timeout = '${opts.statementTimeout ?? "30min"}';`,
  ];

  plan.steps.forEach((step, i) => {
    lines.push("", `-- Step ${i + 1}: ${step.title}`);
    lines.push(`--   risk=${step.risk}, ${step.reversibility}${step.transactional ? "" : ", outside a transaction"}${step.phase === "contract" ? ", CONTRACT phase" : ""}`);
    if (step.rollbackSql) lines.push(`--   rollback: ${step.rollbackSql.replace(/\n/g, " ")}`);

    const sql = step.manual ? step.sql : `${step.sql.replace(/;\s*$/, "")};`;
    if (step.phase === "contract" && !step.manual && !opts.allowDataLoss) {
      lines.push("--   DATA-LOSSY: commented out. Re-render with --allow-data-loss after the app no longer uses it.");
      lines.push(...sql.split("\n").map((l) => `-- ${l}`));
    } else {
      lines.push(sql);
    }
  });
  return `${lines.join("\n")}\n`;
}

/** One line saying how far the plan was checked, so nobody over-trusts it. */
export function acceptanceNote(plan: MigrationPlan): string {
  if (plan.acceptedBy === "validator+shadow") return "Accepted after the guardrail validator AND a passing shadow run on a disposable copy of the target schema.";
  if (plan.acceptedBy === "validator") return "WARNING: accepted by the guardrail validator only (PGVOUCH_SHADOW_VERIFY=off). It is safe but NOT proven complete; run `pgvouch shadow`.";
  if (plan.fellBack) return `Deterministic rules plan. The LLM plan was not used: ${plan.fallbackReason}`;
  return "Deterministic rules plan (no LLM involved).";
}
