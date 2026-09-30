import type { Schema } from "../introspect/types.js";
import { analyzeParsed } from "../locks/analyze.js";
import { maxRisk } from "../locks/risk.js";
import { classifyReversibility, type Reversibility } from "../reversibility/classify.js";
import { rewriteMigration } from "../rewrite/rewrite.js";
import { parseSql, type ParsedStatement } from "../sql/parse.js";
import type { DesiredChange } from "./desired.js";
import type { PlanStep } from "./types.js";

export interface RawStep {
  title: string;
  sql: string;
  rationale: string;
  /** Set for PgVouch's own batched backfill loops (they only fill NULLs in a new column). */
  backfill?: boolean;
}

/** Rules-only path: raw DDL -> F6 safe rewrites -> steps. */
export async function stepsFromChanges(changes: DesiredChange[], target: Schema): Promise<PlanStep[]> {
  const raw: RawStep[] = [];
  for (const change of changes) {
    if (change.manual) {
      raw.push({ title: change.title, sql: change.sql, rationale: "Needs a human decision." });
      continue;
    }
    const rewritten = await rewriteMigration(change.sql, { schema: target });
    for (const s of rewritten.statements) {
      for (const step of s.steps) {
        raw.push({
          title: change.title,
          sql: step.sql,
          rationale: step.note ? `${s.explanation} ${step.note}` : s.explanation,
          backfill: step.kind === "backfill",
        });
      }
    }
  }
  return finalizeSteps(raw, target);
}

/**
 * Computes everything about a step that must NOT come from the LLM: risk, lock
 * behaviour, reversibility, rollback SQL and phase. Steps are analyzed in order, as one
 * script after SET lock_timeout, so each step's risk reflects what earlier steps did.
 */
export async function finalizeSteps(raw: RawStep[], target: Schema): Promise<PlanStep[]> {
  const perStep: ParsedStatement[][] = [];
  for (const step of raw) perStep.push(await parseSql(step.sql));

  const [header] = await parseSql("SET lock_timeout = '3s'");
  const analysis = analyzeParsed([header!, ...perStep.flat()], target);
  let k = 1; // index into analysis.statements, after the header

  return raw.map((step, i) => {
    const stmts = perStep[i]!;
    const analyses = analysis.statements.slice(k, k + stmts.length);
    k += stmts.length;
    const manual = stmts.length === 0; // comment-only step: an action for a human
    // Our generated backfill loop (a DO block) only fills NULLs in a column this plan
    // added, so dropping that column undoes it. Anything else is classified statement by statement.
    // BEGIN/COMMIT around a step (the type-change swap) change nothing themselves.
    const rev = step.backfill ? [] : stmts.filter((s) => s.type !== "TransactionStmt").map((s) => classifyReversibility(s, target));
    const dataLossy = rev.some((r) => r.reversibility === "data-lossy");
    return {
      title: step.title,
      sql: step.sql,
      rationale: step.rationale,
      risk: maxRisk(analyses.map((a) => a.risk)),
      reversibility: manual ? "unknown" : worstReversibility(rev.map((r) => r.reversibility)),
      rollbackSql: !manual && rev.length > 0 && rev.every((r) => r.rollbackSql) ? [...rev].reverse().map((r) => r.rollbackSql).join(";\n") : null,
      // A step that COMMITs (our batch loop) or is its own BEGIN...COMMIT block (the
      // type-change swap) can't be wrapped in another transaction.
      transactional: analyses.every((a) => a.transactional) && !/\bCOMMIT;/.test(step.sql) && !stmts.some((s) => s.type === "TransactionStmt"),
      phase: dataLossy || /^-- CONTRACT/.test(step.sql) ? "contract" : "expand",
      manual,
    };
  });
}

function worstReversibility(list: Reversibility[]): Reversibility {
  const order: Reversibility[] = ["reversible", "reversible-with-backfill", "unknown", "data-lossy"];
  return list.reduce<Reversibility>((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a), "reversible");
}
