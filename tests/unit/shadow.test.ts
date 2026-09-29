import { describe, expect, it } from "vitest";
import { diffSchemas } from "../../src/diff/diff.js";
import type { ShadowReport } from "../../src/shadow/shadow.js";
import { verdictFromShadow } from "../../src/shadow/verifier.js";
import { clone, col, schema, table } from "../helpers/schema.js";

const source = schema(
  table("accounts", [col("id", "bigint", { nullable: false }), col("status", "text"), col("region", "text")], { primaryKey: ["id"] }),
);

function report(shadow: typeof source, steps: ShadowReport["steps"]): ShadowReport {
  const remainingDrift = diffSchemas(source, shadow);
  return { verdict: "fail", steps, remainingDrift, expectedRemaining: [], elapsedMs: 1 };
}

describe("verdictFromShadow (accepting an LLM plan)", () => {
  it("accepts when every step applied and the shadow matches the source", () => {
    expect(verdictFromShadow(report(source, [{ step: 1, title: "t", status: "applied" }]))).toEqual({ ok: true });
  });

  it("reports only the failed step, not the drift it left behind", () => {
    const shadow = clone(source);
    delete shadow.tables["public.accounts"]!.columns.region;
    const v = verdictFromShadow(
      report(shadow, [
        { step: 1, title: "read a file", status: "failed", reason: "permission denied for function pg_read_file" },
        { step: 2, title: "add region", status: "skipped", reason: "an earlier step failed" },
      ]),
    );
    expect(v).toEqual({ ok: false, errors: ['step 1 ("read a file") failed in the shadow database: permission denied for function pg_read_file'] });
  });

  it("rejects an incomplete plan: every step applied but drift remains", () => {
    const shadow = clone(source);
    delete shadow.tables["public.accounts"]!.columns.region;
    const v = verdictFromShadow(report(shadow, [{ step: 1, title: "t", status: "applied" }]));
    expect(v).toEqual({ ok: false, errors: ["after applying the plan, column public.accounts.region (text) is missing on target"] });
  });

  it("is stricter than the shadow report: drift left for manual steps still rejects an LLM plan", () => {
    const shadow = clone(source);
    shadow.tables["public.accounts"]!.primaryKey = ["id", "status"];
    const r = report(shadow, []);
    // The shadow report may call this "expected" (the rules plan leaves PK changes to a human)...
    r.expectedRemaining = r.remainingDrift.items;
    // ...but an LLM plan that doesn't fix it is incomplete.
    expect(verdictFromShadow(r)).toMatchObject({ ok: false });
  });

  it("ignores the advisory possible_rename hint", () => {
    const r = report(source, []);
    r.remainingDrift = { ...r.remainingDrift, items: [{ kind: "possible_rename", table: "public.accounts", from: "a", to: "b", severity: "low" }] };
    expect(verdictFromShadow(r)).toEqual({ ok: true });
  });
});
