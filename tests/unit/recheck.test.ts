import { describe, expect, it } from "vitest";
import { withoutValues, type RowDiff } from "../../src/verify/bisect.js";
import { settleRows } from "../../src/verify/recheck.js";

const missing = (id: string, amount = "10.00"): RowDiff => ({ kind: "missing_in_target", key: { id }, source: { id, amount } });
const extra = (id: string): RowDiff => ({ kind: "extra_in_target", key: { id }, target: { id, amount: "1.00" } });
const changed = (id: string, source: string, target: string): RowDiff => ({
  kind: "changed",
  key: { id },
  columns: ["amount"],
  source: { id, amount: source },
  target: { id, amount: target },
});

describe("settleRows (lag tolerance)", () => {
  it("drops differences that match now: they were in flight", () => {
    const before = [missing("1"), extra("2"), changed("3", "5.00", "4.00")];
    expect(settleRows(before, [])).toEqual({ remaining: [], settled: 3 });
  });

  it("keeps a difference that is still there, with its latest values", () => {
    const before = [missing("1"), changed("3", "5.00", "4.00")];
    const now = [changed("3", "5.00", "4.50")];
    expect(settleRows(before, now)).toEqual({ remaining: [changed("3", "5.00", "4.50")], settled: 1 });
  });

  it("flags a row whose source changed between checks: in flight, not necessarily wrong", () => {
    const { remaining } = settleRows([changed("3", "5.00", "4.00")], [changed("3", "6.00", "5.00")]);
    expect(remaining).toEqual([{ ...changed("3", "6.00", "5.00"), sourceChanging: true }]);
  });

  it("flags a row that appeared on, or vanished from, the source in between", () => {
    // Was only on the target, now also on the source (with other values).
    expect(settleRows([extra("2")], [changed("2", "9.00", "1.00")]).remaining[0]!.sourceChanging).toBe(true);
    // Was on both, now deleted on the source but not yet on the target.
    expect(settleRows([changed("3", "5.00", "4.00")], [extra("3")]).remaining[0]!.sourceChanging).toBe(true);
  });

  it("does not flag a row whose source stayed the same: the target is just wrong", () => {
    const { remaining } = settleRows([missing("1")], [missing("1")]);
    expect(remaining[0]!.sourceChanging).toBeUndefined();
  });

  it("keeps the flag once set, even if the source is stable in a later round", () => {
    const round1 = settleRows([changed("3", "5.00", "4.00")], [changed("3", "6.00", "4.00")]).remaining;
    const round2 = settleRows(round1, [changed("3", "6.00", "4.00")]).remaining;
    expect(round2[0]!.sourceChanging).toBe(true);
  });

  it("matches composite keys on every key column", () => {
    const a: RowDiff = { kind: "missing_in_target", key: { account_id: "1", limit_type: "atm" }, source: { amount: "1" } };
    const b: RowDiff = { kind: "missing_in_target", key: { account_id: "1", limit_type: "daily" }, source: { amount: "1" } };
    expect(settleRows([a, b], [b])).toEqual({ remaining: [b], settled: 1 });
  });
});

describe("withoutValues (MCP responses, receipts)", () => {
  it("keeps the kind, key and changed columns, and drops row values that can be personal data", () => {
    const rows = [missing("1"), extra("2"), { ...changed("3", "5.00", "4.00"), sourceChanging: true }].map(withoutValues);
    expect(rows).toEqual([
      { kind: "missing_in_target", key: { id: "1" } },
      { kind: "extra_in_target", key: { id: "2" } },
      { kind: "changed", key: { id: "3" }, columns: ["amount"], sourceChanging: true },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/5\.00|4\.00|10\.00|1\.00/);
  });
});
