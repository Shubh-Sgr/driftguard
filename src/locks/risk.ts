export type Risk = "low" | "medium" | "high" | "critical";
export const RISK_ORDER: Risk[] = ["low", "medium", "high", "critical"];
export const maxRisk = (risks: Risk[]): Risk =>
  risks.reduce((a, b) => (RISK_ORDER.indexOf(b) > RISK_ORDER.indexOf(a) ? b : a), "low" as Risk);

export type SizeBucket = "unknown" | "small" | "medium" | "large";

/**
 * Row estimates come from pg_class.reltuples, which is an estimate (and -1 before the
 * first ANALYZE). So we only use it to pick a coarse bucket, never as an exact count.
 */
export function sizeBucket(estimatedRows: number | null): SizeBucket {
  if (estimatedRows === null || estimatedRows < 0) return "unknown";
  if (estimatedRows < 100_000) return "small";
  if (estimatedRows < 10_000_000) return "medium";
  return "large";
}

export interface RiskInput {
  blocksReads: boolean;
  blocksWrites: boolean;
  /** Reads or rewrites every row while holding the lock. */
  heavy: boolean;
  dataLoss: boolean;
  estimatedRows: number | null;
  lockTimeoutSet: boolean;
}

/**
 * Risk = how badly this statement can hurt a live application.
 *  - Doesn't block reads or writes                -> low (it may be slow, but traffic flows)
 *  - Blocks, but only for a metadata change       -> medium, or low if lock_timeout is set
 *    (it's "instant", but it waits in the lock queue behind long transactions and
 *     every new query queues behind IT — the classic "1 ms ALTER, 30 s outage")
 *  - Blocks while scanning/rewriting the table    -> by size: small medium, medium high,
 *    large critical; unknown size is treated as high (we don't guess "small")
 *  - Destroys data                                -> at least high
 */
export function scoreRisk(input: RiskInput): { risk: Risk; reasons: string[] } {
  const reasons: string[] = [];
  let risk: Risk;

  if (!input.blocksReads && !input.blocksWrites) {
    risk = "low";
    reasons.push("does not block normal reads or writes");
  } else if (!input.heavy) {
    risk = input.lockTimeoutSet ? "low" : "medium";
    reasons.push(
      input.lockTimeoutSet
        ? "metadata-only change; lock_timeout limits time spent waiting in the lock queue"
        : "metadata-only change, but without lock_timeout it can wait in the lock queue and stall all traffic behind it",
    );
  } else {
    const bucket = sizeBucket(input.estimatedRows);
    risk = bucket === "small" ? "medium" : bucket === "medium" ? "high" : bucket === "large" ? "critical" : "high";
    const rows = input.estimatedRows !== null && input.estimatedRows >= 0 ? `~${Math.round(input.estimatedRows).toLocaleString("en-US")} rows` : "unknown size";
    reasons.push(`${input.blocksReads ? "blocks reads and writes" : "blocks writes"} while it processes the whole table (${rows})`);
  }

  if (input.dataLoss) {
    risk = maxRisk([risk, "high"]);
    reasons.push("permanently removes data");
  }
  return { risk, reasons };
}
