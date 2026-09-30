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
  /** Computed by PgVouch's analyzer, never taken from the LLM. */
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
  /** The last check this attempt reached: where it was rejected, or what accepted it. */
  stage: "llm" | "shape" | "validator" | "shadow";
  errors: string[];
}

/**
 * The result of proving a candidate plan (in practice: a shadow run).
 * "unavailable" means the proof could not run at all (e.g. Docker is down); it says
 * nothing about the plan, so the planner must not ask the LLM to "fix" anything.
 */
export type PlanVerdict = { ok: true } | { ok: false; errors: string[] } | { unavailable: string };
export type PlanVerifier = (plan: MigrationPlan) => Promise<PlanVerdict>;

export interface MigrationPlan {
  /** Who wrote the steps. "rules" = PgVouch's deterministic generator. */
  author: "llm" | "rules";
  model: string | null;
  summary: string;
  steps: PlanStep[];
  /** Every LLM attempt and why it was rejected. Empty for rules-only plans. */
  attempts: PlanAttempt[];
  /** True if an LLM was asked but none of its plans was accepted. */
  fellBack: boolean;
  /** Why the LLM plan was not used; null when it was used or no LLM was asked. */
  fallbackReason: string | null;
  /**
   * What an LLM plan had to pass to be accepted. "validator" alone proves the plan is
   * safe, not that it is complete; "validator+shadow" also proves the result matches
   * the source. null for rules-only plans (deterministic, covered by the eval suite).
   */
  acceptedBy: "validator+shadow" | "validator" | null;
}
