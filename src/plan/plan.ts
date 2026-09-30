import { z } from "zod";
import type { DriftReport } from "../diff/types.js";
import type { Schema } from "../introspect/types.js";
import { LlmError, type LlmProvider } from "../llm/provider.js";
import { desiredChanges } from "./desired.js";
import { buildPrompt, SYSTEM_PROMPT } from "./prompt.js";
import { finalizeSteps, stepsFromChanges } from "./steps.js";
import { LlmPlanSchema, type MigrationPlan, type PlanAttempt, type PlanVerifier } from "./types.js";
import { validatePlanSql } from "./validate.js";

export interface PlanOptions {
  drift: DriftReport;
  source: Schema;
  target: Schema;
  /** Omit for a rules-only plan (no LLM involved at all). */
  llm?: LlmProvider;
  /**
   * Proves a validated LLM plan (a shadow run in practice). Omit to accept plans on
   * the validator alone, which proves them safe but not complete.
   */
  verify?: PlanVerifier;
  /** 2 = one try plus one retry with the errors from the failed check. */
  maxAttempts?: number;
}

// Bounds on what we send back to the LLM on a retry. A shadow failure can list many
// drift items; a long prompt costs time on a small local model and buries the point.
export const MAX_FEEDBACK_ERRORS = 10;
export const MAX_FEEDBACK_CHARS = 300;

/**
 * F7: "the LLM proposes, code decides".
 *
 *   LLM plan -> JSON parse -> zod shape check -> guardrail validator -> verifier (shadow run)
 *     all pass    -> use it (risk/reversibility still computed by PgVouch, not the LLM)
 *     a check fails -> retry once with that check's errors -> still failing -> rules-only plan
 *     verifier unavailable -> rules-only plan straight away (retrying can't help)
 */
export async function planMigration(opts: PlanOptions): Promise<MigrationPlan> {
  const { drift, source, target, llm, verify } = opts;
  const rulesPlan = async (attempts: PlanAttempt[], fallbackReason: string | null): Promise<MigrationPlan> => ({
    author: "rules",
    model: llm?.id ?? null,
    summary: summarize(drift),
    steps: await stepsFromChanges(desiredChanges(drift, source), target),
    attempts,
    fellBack: fallbackReason !== null,
    fallbackReason,
    acceptedBy: null,
  });

  // Nothing to do, or no LLM configured: the deterministic plan is the answer.
  if (!llm || drift.identical) return rulesPlan([], null);

  const attempts: PlanAttempt[] = [];
  const maxAttempts = opts.maxAttempts ?? 2;
  let feedback: string[] | undefined;
  const jsonSchema = z.toJSONSchema(LlmPlanSchema);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const reject = (stage: PlanAttempt["stage"], errors: string[]) => {
      attempts.push({ attempt, valid: false, stage, errors });
      feedback = limitFeedback(errors);
    };

    let raw: string;
    try {
      raw = await llm.complete({ system: SYSTEM_PROMPT, prompt: buildPrompt(drift, source, target, feedback), jsonSchema });
    } catch (err) {
      // The LLM being down is not fatal: we still produce the rules-only plan.
      if (!(err instanceof LlmError)) throw err;
      attempts.push({ attempt, valid: false, stage: "llm", errors: [err.message] });
      return rulesPlan(attempts, `LLM unavailable: ${err.message}`);
    }

    const shape = LlmPlanSchema.safeParse(parseJson(raw));
    if (!shape.success) {
      reject("shape", shape.error.issues.map((i) => `response shape: ${i.path.join(".") || "(root)"}: ${i.message}`));
      continue;
    }

    const check = await validatePlanSql(shape.data.steps, target);
    if (!check.valid) {
      reject("validator", check.errors); // never shadow-run a plan the validator rejected
      continue;
    }

    const candidate: MigrationPlan = {
      author: "llm",
      model: llm.id,
      summary: shape.data.summary,
      steps: await finalizeSteps(shape.data.steps, target),
      attempts,
      fellBack: false,
      fallbackReason: null,
      acceptedBy: verify ? "validator+shadow" : "validator",
    };
    if (!verify) {
      attempts.push({ attempt, valid: true, stage: "validator", errors: [] });
      return candidate;
    }

    const verdict = await verify(candidate);
    if ("unavailable" in verdict) {
      // Not the plan's fault, so don't ask the LLM to "fix" it; an unproven plan is
      // not accepted either. The rules plan is the safe answer.
      attempts.push({ attempt, valid: false, stage: "shadow", errors: [verdict.unavailable] });
      return rulesPlan(attempts, `shadow run unavailable, LLM plan not proven: ${verdict.unavailable}`);
    }
    if (verdict.ok) {
      attempts.push({ attempt, valid: true, stage: "shadow", errors: [] });
      return candidate;
    }
    reject("shadow", verdict.errors);
  }

  const last = attempts.at(-1);
  return rulesPlan(attempts, `no LLM plan was accepted in ${maxAttempts} attempt(s)${last ? `; the last one failed the ${STAGE_LABEL[last.stage]}` : ""}`);
}

const STAGE_LABEL: Record<PlanAttempt["stage"], string> = {
  llm: "LLM call",
  shape: "response shape check",
  validator: "validator",
  shadow: "shadow run",
};

/** Keeps retry feedback short: the first few errors, each cut to a readable length. */
export function limitFeedback(errors: string[]): string[] {
  const shown = errors.slice(0, MAX_FEEDBACK_ERRORS).map((e) => (e.length > MAX_FEEDBACK_CHARS ? `${e.slice(0, MAX_FEEDBACK_CHARS - 3)}...` : e));
  if (errors.length > MAX_FEEDBACK_ERRORS) shown.push(`(${errors.length - MAX_FEEDBACK_ERRORS} more problem(s) not shown)`);
  return shown;
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
