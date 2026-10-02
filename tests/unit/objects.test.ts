import { describe, expect, it } from "vitest";
import { diffSchemas } from "../../src/diff/diff.js";
import { driftItemKey } from "../../src/diff/types.js";
import type { Schema } from "../../src/introspect/types.js";
import { planMigration } from "../../src/plan/plan.js";
import { renderPlanSql } from "../../src/plan/render.js";
import { clone, col, schema, table } from "../helpers/schema.js";

// A source with one of each object type around an `audit` table.
function withObjects(): Schema {
  const s = schema(
    table("audit", [col("id", "bigint", { nullable: false }), col("created_at", "timestamp with time zone")], {
      primaryKey: ["id"],
      estimatedRows: 1_000,
      rowSecurity: { enabled: true, forced: false },
    }),
  );
  s.views = { "public.audit_counts": { schema: "public", name: "audit_counts", materialized: false, definition: " SELECT count(*) AS n\n   FROM audit;" } };
  s.routines = {
    "public.set_created_at()": {
      schema: "public",
      name: "set_created_at",
      args: "",
      kind: "function",
      definition: "CREATE OR REPLACE FUNCTION public.set_created_at()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$ BEGIN NEW.created_at := now(); RETURN NEW; END $function$",
    },
  };
  s.triggers = {
    "public.audit.audit_created_at": {
      table: "public.audit",
      name: "audit_created_at",
      definition: "CREATE TRIGGER audit_created_at BEFORE INSERT ON public.audit FOR EACH ROW EXECUTE FUNCTION set_created_at()",
      state: "enabled",
    },
  };
  s.enums = { "public.card_status": { schema: "public", name: "card_status", labels: ["active", "frozen", "closed"] } };
  s.extensions = { pgcrypto: { name: "pgcrypto", version: "1.3", schema: "public" } };
  s.policies = {
    "public.audit.audit_read": { table: "public.audit", name: "audit_read", definition: "CREATE POLICY audit_read ON audit AS PERMISSIVE FOR SELECT TO PUBLIC USING (true)" },
  };
  return s;
}

const keys = (s: Schema, t: Schema) => diffSchemas(s, t).items.map((i) => `${driftItemKey(i)}=${i.severity}`);

describe("object drift (views, functions, triggers, enums, extensions, RLS)", () => {
  it("finds nothing when everything matches", () => {
    const s = withObjects();
    expect(diffSchemas(s, clone(s)).identical).toBe(true);
  });

  it("reports missing objects as high and extra ones as low/medium", () => {
    const s = withObjects();
    const empty = clone(s);
    empty.views = {};
    empty.routines = {};
    empty.triggers = {};
    empty.enums = {};
    empty.extensions = {};
    empty.policies = {};
    expect(keys(s, empty)).toEqual([
      "enum_missing:public.card_status=high",
      "extension_missing:pgcrypto=high",
      "function_missing:public.set_created_at()=high",
      "policy_missing:public.audit.audit_read=high",
      "trigger_missing:public.audit.audit_created_at=high",
      "view_missing:public.audit_counts=high",
    ]);
    expect(keys(empty, s)).toEqual([
      "enum_extra:public.card_status=low",
      "extension_extra:pgcrypto=low",
      "function_extra:public.set_created_at()=low",
      "policy_extra:public.audit.audit_read=medium",
      "trigger_extra:public.audit.audit_created_at=medium",
      "view_extra:public.audit_counts=low",
    ]);
  });

  it("treats a disabled trigger as high: its logic silently stops", () => {
    const s = withObjects();
    const t = clone(s);
    t.triggers!["public.audit.audit_created_at"]!.state = "disabled";
    expect(diffSchemas(s, t).items).toEqual([
      { kind: "trigger_changed", table: "public.audit", name: "audit_created_at", from: "enabled", to: "disabled", severity: "high" },
    ]);
  });

  it("rates an enum that lost a label high, one with an extra label medium", () => {
    const s = withObjects();
    const lost = clone(s);
    lost.enums!["public.card_status"]!.labels = ["active", "closed"];
    const extra = clone(s);
    extra.enums!["public.card_status"]!.labels = ["active", "frozen", "closed", "lost"];
    expect(keys(s, lost)).toEqual(["enum_changed:public.card_status=high"]);
    expect(keys(s, extra)).toEqual(["enum_changed:public.card_status=medium"]);
  });

  it("rates weaker row-level security on the target high, stronger medium", () => {
    const s = withObjects();
    const off = clone(s);
    off.tables["public.audit"]!.rowSecurity = { enabled: false, forced: false };
    const forced = clone(s);
    forced.tables["public.audit"]!.rowSecurity = { enabled: true, forced: true };
    expect(keys(s, off)).toEqual(["row_security_changed:public.audit=high"]);
    expect(keys(s, forced)).toEqual(["row_security_changed:public.audit=medium"]);
  });

  it("reports changed definitions and extension versions", () => {
    const s = withObjects();
    const t = clone(s);
    t.views!["public.audit_counts"]!.definition = " SELECT 1 AS n;";
    t.routines!["public.set_created_at()"]!.definition += " -- changed";
    t.extensions!.pgcrypto!.version = "1.2";
    t.policies!["public.audit.audit_read"]!.definition = "CREATE POLICY audit_read ON audit AS PERMISSIVE FOR SELECT TO PUBLIC USING (false)";
    expect(keys(s, t)).toEqual([
      "extension_changed:pgcrypto=low",
      "function_changed:public.set_created_at()=medium",
      "policy_changed:public.audit.audit_read=high",
      "view_changed:public.audit_counts=medium",
    ]);
  });

  it("doesn't list triggers and policies of a missing table separately", () => {
    const s = withObjects();
    const t = clone(s);
    delete t.tables["public.audit"];
    t.triggers = {};
    t.policies = {};
    expect(keys(s, t)).toEqual(["table_missing:public.audit=high"]);
  });
});

describe("rules plan for object drift", () => {
  const plan = async (s: Schema, t: Schema) => planMigration({ drift: diffSchemas(s, t), source: s, target: t });

  it("re-creates a missing table with its trigger, policy and RLS, policy before RLS is switched on", async () => {
    const s = withObjects();
    const t = clone(s);
    delete t.tables["public.audit"];
    t.triggers = {};
    t.policies = {};
    const sqls = (await plan(s, t)).steps.map((x) => x.sql);
    const policy = sqls.findIndex((x) => x.startsWith("CREATE POLICY audit_read"));
    const rls = sqls.findIndex((x) => x.includes("ENABLE ROW LEVEL SECURITY"));
    expect(sqls[0]).toMatch(/^CREATE TABLE audit/);
    expect(sqls).toContain(s.triggers!["public.audit.audit_created_at"]!.definition);
    expect(policy).toBeGreaterThan(0);
    expect(rls).toBeGreaterThan(policy);
  });

  it("creates objects in dependency order: enum, function, view, trigger", async () => {
    const s = withObjects();
    const t = clone(s);
    t.enums = {};
    t.routines = {};
    t.views = {};
    t.triggers = {};
    const sqls = (await plan(s, t)).steps.map((x) => x.sql);
    const at = (re: RegExp) => sqls.findIndex((x) => re.test(x));
    expect(at(/^CREATE TYPE card_status AS ENUM \('active', 'frozen', 'closed'\)$/)).toBe(0);
    expect(at(/^CREATE OR REPLACE FUNCTION public\.set_created_at/)).toBeGreaterThan(0);
    expect(at(/^CREATE OR REPLACE VIEW audit_counts AS SELECT count/)).toBeGreaterThan(at(/FUNCTION public\.set_created_at/));
    expect(at(/^CREATE TRIGGER audit_created_at/)).toBeGreaterThan(at(/VIEW audit_counts/));
  });

  it("adds missing enum labels in place, at their position", async () => {
    const s = withObjects();
    const t = clone(s);
    t.enums!["public.card_status"]!.labels = ["active", "closed"];
    expect((await plan(s, t)).steps.map((x) => x.sql)).toEqual(["ALTER TYPE card_status ADD VALUE IF NOT EXISTS 'frozen' AFTER 'active'"]);
  });

  it("leaves an enum with extra labels to a human (labels can't be removed in place)", async () => {
    const s = withObjects();
    const t = clone(s);
    t.enums!["public.card_status"]!.labels = ["active", "frozen", "closed", "lost"];
    const [step] = (await plan(s, t)).steps;
    expect(step).toMatchObject({ manual: true });
    expect(step!.sql).toMatch(/^-- MANUAL: enum type public\.card_status/);
  });

  it("re-enables a disabled trigger", async () => {
    const s = withObjects();
    const t = clone(s);
    t.triggers!["public.audit.audit_created_at"]!.state = "disabled";
    expect((await plan(s, t)).steps.map((x) => x.sql)).toEqual(["ALTER TABLE audit ENABLE TRIGGER audit_created_at"]);
  });

  it("replaces a changed policy atomically, in one step that is its own transaction", async () => {
    const s = withObjects();
    const t = clone(s);
    t.policies!["public.audit.audit_read"]!.definition = "CREATE POLICY audit_read ON audit AS PERMISSIVE FOR SELECT TO PUBLIC USING (false)";
    const steps = (await plan(s, t)).steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]!.sql.split(";\n")).toEqual(["BEGIN", "DROP POLICY audit_read ON audit", s.policies!["public.audit.audit_read"]!.definition, "COMMIT"]);
    expect(steps[0]!.transactional).toBe(false);
  });

  it.each([
    // target state, source state, the step, its rollback (back to exactly the target's state)
    [{ enabled: false, forced: false }, { enabled: true, forced: false }, "ALTER TABLE audit ENABLE ROW LEVEL SECURITY", "ALTER TABLE audit DISABLE ROW LEVEL SECURITY"],
    [{ enabled: true, forced: true }, { enabled: true, forced: false }, "ALTER TABLE audit NO FORCE ROW LEVEL SECURITY", "ALTER TABLE audit FORCE ROW LEVEL SECURITY"],
    [
      { enabled: true, forced: true },
      { enabled: false, forced: false },
      "ALTER TABLE audit DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY",
      "ALTER TABLE audit FORCE ROW LEVEL SECURITY;\nALTER TABLE audit ENABLE ROW LEVEL SECURITY",
    ],
  ])("changes only the row-level security flags that differ, so the rollback restores the target (%o -> %o)", async (have, want, sql, rollback) => {
    const s = withObjects();
    s.tables["public.audit"]!.rowSecurity = want;
    const t = clone(s);
    t.tables["public.audit"]!.rowSecurity = have;
    const [step] = (await plan(s, t)).steps;
    expect(step).toMatchObject({ sql, rollbackSql: rollback });
  });

  it("leaves a missing extension to a human (it needs a privileged role)", async () => {
    const s = withObjects();
    const t = clone(s);
    t.extensions = {};
    const [step] = (await plan(s, t)).steps;
    expect(step).toMatchObject({ manual: true });
    expect(step!.sql).toBe("-- MANUAL (needs a privileged role): CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public VERSION '1.3';");
  });

  it("holds back drops of extra objects as contract steps (commented out by default)", async () => {
    const s = withObjects();
    const t = clone(s);
    t.views!["public.extra_view"] = { schema: "public", name: "extra_view", materialized: true, definition: " SELECT 1;" };
    t.routines!["public.extra_fn(integer)"] = { schema: "public", name: "extra_fn", args: "integer", kind: "function", definition: "CREATE OR REPLACE FUNCTION public.extra_fn(integer) ..." };
    const p = await plan(s, t);
    expect(p.steps.map((x) => [x.sql, x.phase])).toEqual([
      ["DROP ROUTINE extra_fn(integer)", "contract"],
      ["DROP MATERIALIZED VIEW extra_view", "contract"],
    ]);
    expect(renderPlanSql(p)).toContain("-- DROP MATERIALIZED VIEW extra_view;");
  });
});
