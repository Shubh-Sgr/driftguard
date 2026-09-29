import { z } from "zod";
import type { Risk } from "../locks/risk.js";
import type { Reversibility } from "../reversibility/classify.js";

/**
 * What we ask the LLM to return. Deliberately small and flat: every extra field is
 * another thing a model can get wrong.
 */
export const LlmPlanSchema = z.object({
  summary: z.string().min(1),
  steps: z
    .array(
      z.object({
        title: z.string().min(1),
        sql: z.string().min(1),
        rationale: z.string(),
      }),
    )
    .min(1),
});
export type LlmPlan = z.infer<typeof LlmPlanSchema>;

export interface PlanStep {
  title: string;
  /** One or more SQL statements; a comment-only step is a manual action for a human. */
  sql: string;
  rationale: string;
  /** Computed by DriftGuard's analyzer, never taken from the LLM. */
  risk: Risk;
  reversibility: Reversibility;
  rollbackSql: string | null;
  /** false = must run outside BEGIN/COMMIT. */
  transactional: boolean;
  /** contract = removes things (often data-lossy); run later, after the app is updated. */
  phase: "expand" | "contract";
  manual: boolean;
}

export interface PlanAttempt {
  attempt: number;
  valid: boolean;
  errors: string[];
}

export interface MigrationPlan {
  /** Who wrote the steps. "rules" = DriftGuard's deterministic generator. */
  author: "llm" | "rules";
  model: string | null;
  summary: string;
  steps: PlanStep[];
  /** Every LLM attempt and why it was rejected. Empty for rules-only plans. */
  attempts: PlanAttempt[];
  /** True if an LLM was asked but every attempt failed validation. */
  fellBack: boolean;
}
