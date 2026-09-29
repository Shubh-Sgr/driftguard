import { describeDrift } from "../diff/describe.js";
import type { Schema } from "../introspect/types.js";
import type { PlanVerdict, PlanVerifier } from "../plan/types.js";
import { shadowRun, ShadowUnavailableError, type ShadowReport } from "./shadow.js";

/**
 * Builds the verifier the planner uses to accept an LLM plan only if it actually
 * works: the plan is applied to a disposable copy of the target's schema and the
 * result must match the source. The user's databases are only read (schema dump).
 */
export function shadowVerifier(opts: { targetUrl: string; source: Schema; image?: string }): PlanVerifier {
  return async (plan) => {
    try {
      // allowDataLoss: true because the shadow is throwaway. Otherwise contract steps
      // are skipped and their drift is "expected", so a plan that does nothing would
      // pass whenever the only drift is extra columns or tables.
      const report = await shadowRun({ targetUrl: opts.targetUrl, source: opts.source, plan, allowDataLoss: true, image: opts.image });
      return verdictFromShadow(report);
    } catch (err) {
      if (err instanceof ShadowUnavailableError) return { unavailable: err.message };
      throw err;
    }
  };
}

/**
 * Stricter than the shadow report's own verdict: an LLM plan is accepted only if the
 * shadow ends up identical to the source. The report tolerates drift that the RULES
 * plan leaves to manual steps (e.g. a primary key change); an LLM plan that leaves it
 * would be incomplete, so here only the advisory possible_rename hint is ignored.
 */
export function verdictFromShadow(report: ShadowReport): PlanVerdict {
  // A failed step stops the run, so any remaining drift is just its consequence:
  // report the failure alone, which is what the LLM has to fix.
  const failed = report.steps.filter((s) => s.status === "failed");
  if (failed.length) {
    return { ok: false, errors: failed.map((s) => `step ${s.step} ("${s.title}") failed in the shadow database: ${s.reason}`) };
  }
  const errors = report.remainingDrift.items
    .filter((item) => item.kind !== "possible_rename")
    .map((item) => `after applying the plan, ${describeDrift(item).replace(/\s+/g, " ")}`);
  return errors.length ? { ok: false, errors } : { ok: true };
}
