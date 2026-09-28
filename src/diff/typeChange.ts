// Classifies a column type change as "widening" (every old value still fits) or not.
// Only a short, explicit list counts as widening; anything unknown is treated as
// risky. False alarms are cheap, and silently calling a narrowing safe is not.

const INTEGER_RANK: Record<string, number> = { smallint: 1, integer: 2, bigint: 3 };

const VARCHAR = /^character varying(?:\((\d+)\))?$/;
const NUMERIC = /^numeric(?:\((\d+),(\d+)\))?$/;

export function isWideningTypeChange(from: string, to: string): boolean {
  if (from === to) return true;

  // smallint -> integer -> bigint
  const fromInt = INTEGER_RANK[from];
  const toInt = INTEGER_RANK[to];
  if (fromInt !== undefined && toInt !== undefined) return toInt > fromInt;

  // varchar(n) -> varchar(m >= n), varchar(n) -> varchar (unbounded), varchar -> text
  const fromVc = VARCHAR.exec(from);
  if (fromVc) {
    if (to === "text") return true;
    const toVc = VARCHAR.exec(to);
    if (toVc) {
      if (toVc[1] === undefined) return true; // unbounded varchar
      if (fromVc[1] === undefined) return false; // unbounded -> bounded
      return Number(toVc[1]) >= Number(fromVc[1]);
    }
    return false;
  }

  // numeric(p,s) -> numeric(p2,s) with p2 >= p, or -> unconstrained numeric.
  // A scale change is never "widening": it rounds existing values.
  const fromNum = NUMERIC.exec(from);
  const toNum = NUMERIC.exec(to);
  if (fromNum && toNum) {
    if (toNum[1] === undefined) return true;
    if (fromNum[1] === undefined) return false;
    return Number(toNum[1]) >= Number(fromNum[1]) && toNum[2] === fromNum[2];
  }

  return false;
}
