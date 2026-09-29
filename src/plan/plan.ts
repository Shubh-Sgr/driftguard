import { z } from "zod";
import type { DriftReport } from "../diff/types.js";
import type { Schema } from "../introspect/types.js";
import { LlmError, type LlmProvider } from "../llm/provider.js";
import { desiredChanges } from "./desired.js";
import { buildPrompt, SYSTEM_PROMPT } from "./prompt.js";
import { finalizeSteps, stepsFromChanges } from "./steps.js";
import { LlmPlanSchema, type MigrationPlan, type PlanAttempt } from "./types.js";
import { validatePlanSql } from "./validate.js";

export interface PlanOptions {
  drift: DriftReport;
  source: Schema;
  target: Schema;
  /** Omit for a rules-only plan (no LLM involved at all). */
  llm?: LlmProvider;
  /** 2 = one try plus one retry with the validator's errors. */
  maxAttempts?: number;
}

/**
 * F7: "the LLM proposes, code decides".
 *
 *   LLM plan -> JSON parse -> zod shape check -> guardrail validator
 *     valid   -> use it (risk/reversibility still computed by DriftGuard, not the LLM)
 *     invalid -> retry once with the exact errors -> still invalid -> rules-only plan
 */
export async function planMigration(opts: PlanOptions): Promise<MigrationPlan> {
  const { drift, source, target, llm } = opts;
  const rulesPlan = async (fellBack: boolean, attempts: PlanAttempt[]): Promise<MigrationPlan> => ({
    author: "rules",
    model: llm?.id ?? null,
    summary: summarize(drift),
    steps: await stepsFromChanges(desiredChanges(drift, source), target),
    attempts,
    fellBack,
  });

  // Nothing to do, or no LLM configured: the deterministic plan is the answer.
  if (!llm || drift.identical) return rulesPlan(false, []);

  const attempts: PlanAttempt[] = [];
  let feedback: string[] | undefined;
  const jsonSchema = z.toJSONSchema(LlmPlanSchema);

  for (let attempt = 1; attempt <= (opts.maxAttempts ?? 2); attempt++) {
    let errors: string[];
    try {
      const raw = await llm.complete({ system: SYSTEM_PROMPT, prompt: buildPrompt(drift, source, target, feedback), jsonSchema });
      const shape = LlmPlanSchema.safeParse(parseJson(raw));
      if (!shape.success) {
        errors = shape.error.issues.map((i) => `response shape: ${i.path.join(".") || "(root)"}: ${i.message}`);
      } else {
        const check = await validatePlanSql(shape.data.steps, target);
        if (check.valid) {
          attempts.push({ attempt, valid: true, errors: [] });
          return {
            author: "llm",
            model: llm.id,
            summary: shape.data.summary,
            steps: await finalizeSteps(shape.data.steps, target),
            attempts,
            fellBack: false,
          };
        }
        errors = check.errors;
      }
    } catch (err) {
      // The LLM being down is not fatal: we still produce the rules-only plan.
      if (err instanceof LlmError) {
        attempts.push({ attempt, valid: false, errors: [err.message] });
        break;
      }
      throw err;
    }
    attempts.push({ attempt, valid: false, errors });
    feedback = errors;
  }

  return rulesPlan(true, attempts);
}

function parseJson(raw: string): unknown {
  // Some models wrap JSON in a ```json fence despite being told not to.
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // zod then reports "expected object"
  }
}

function summarize(drift: DriftReport): string {
  if (drift.identical) return "Schemas already match; nothing to do.";
  const { high, medium, low } = drift.summary;
  return `Fix ${drift.items.length} drift item(s) (${high} high, ${medium} medium, ${low} low) using non-blocking steps.`;
}
