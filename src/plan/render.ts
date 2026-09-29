import type { MigrationPlan } from "./types.js";

export interface RenderOptions {
  lockTimeout?: string;
  statementTimeout?: string;
  /** Contract (data-lossy) steps are commented out unless this is set. */
  allowDataLoss?: boolean;
}

/** Renders a plan as a SQL script a human reviews and runs. DriftGuard never runs it. */
export function renderPlanSql(plan: MigrationPlan, opts: RenderOptions = {}): string {
  const lines = [
    `-- DriftGuard migration plan (${plan.author === "llm" ? `LLM: ${plan.model}, validated` : "rules-only"}${plan.fellBack ? ", LLM plan rejected -> fallback" : ""})`,
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
