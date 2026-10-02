import type { Schema, Table } from "../introspect/types.js";
import type { DriftItem } from "./types.js";

/**
 * Drift in the objects around the tables: views, functions/procedures, triggers, enum
 * types, extensions and row-level security. Without these, a missing audit trigger or a
 * dropped RLS policy (a data-exposure bug) would be reported as "no drift".
 *
 * Severity follows the same idea as for tables: high when the app breaks or a guarantee
 * is lost (missing object, disabled trigger, weaker security), medium when behaviour may
 * differ, low when only unexpected extra state exists.
 */
export function diffObjects(source: Schema, target: Schema): DriftItem[] {
  const items: DriftItem[] = [];

  const sv = source.views ?? {};
  const tv = target.views ?? {};
  for (const key of union(sv, tv)) {
    const s = sv[key];
    const t = tv[key];
    if (s && !t) items.push({ kind: "view_missing", name: key, materialized: s.materialized, severity: "high" });
    else if (!s && t) items.push({ kind: "view_extra", name: key, materialized: t.materialized, severity: "low" });
    else if (s && t && (s.definition !== t.definition || s.materialized !== t.materialized)) {
      items.push({ kind: "view_changed", name: key, from: s.definition, to: t.definition, severity: "medium" });
    }
  }

  const sr = source.routines ?? {};
  const tr = target.routines ?? {};
  for (const key of union(sr, tr)) {
    const s = sr[key];
    const t = tr[key];
    if (s && !t) items.push({ kind: "function_missing", name: key, severity: "high" });
    else if (!s && t) items.push({ kind: "function_extra", name: key, severity: "low" });
    else if (s && t && s.definition !== t.definition) {
      items.push({ kind: "function_changed", name: key, from: s.definition, to: t.definition, severity: "medium" });
    }
  }

  // Triggers and policies of a table (or view) that exists on one side only are covered
  // by that table's own drift item, like its columns and indexes.
  const onBothSides = (relation: string) => hasRelation(source, relation) && hasRelation(target, relation);

  const st = source.triggers ?? {};
  const tt = target.triggers ?? {};
  for (const key of union(st, tt)) {
    const s = st[key];
    const t = tt[key];
    const table = (s ?? t)!.table;
    if (!onBothSides(table)) continue;
    if (s && !t) items.push({ kind: "trigger_missing", table, name: s.name, severity: "high" });
    // An extra trigger runs code on every write that the source never runs.
    else if (!s && t) items.push({ kind: "trigger_extra", table, name: t.name, severity: "medium" });
    else if (s && t && s.definition !== t.definition) {
      items.push({ kind: "trigger_changed", table, name: s.name, from: s.definition, to: t.definition, severity: "high" });
    } else if (s && t && s.state !== t.state) {
      // A disabled trigger silently skips its logic (audit rows, updated_at, ...).
      items.push({ kind: "trigger_changed", table, name: s.name, from: s.state, to: t.state, severity: "high" });
    }
  }

  const se = source.enums ?? {};
  const te = target.enums ?? {};
  for (const key of union(se, te)) {
    const s = se[key];
    const t = te[key];
    if (s && !t) items.push({ kind: "enum_missing", name: key, severity: "high" });
    else if (!s && t) items.push({ kind: "enum_extra", name: key, severity: "low" });
    else if (s && t && s.labels.join("\u0000") !== t.labels.join("\u0000")) {
      // A label the source has but the target lacks makes the app's inserts fail.
      const lost = s.labels.some((l) => !t.labels.includes(l));
      items.push({ kind: "enum_changed", name: key, from: s.labels, to: t.labels, severity: lost ? "high" : "medium" });
    }
  }

  const sx = source.extensions ?? {};
  const tx = target.extensions ?? {};
  for (const key of union(sx, tx)) {
    const s = sx[key];
    const t = tx[key];
    if (s && !t) items.push({ kind: "extension_missing", name: key, severity: "high" });
    else if (!s && t) items.push({ kind: "extension_extra", name: key, severity: "low" });
    else if (s && t && s.version !== t.version) {
      items.push({ kind: "extension_changed", name: key, from: s.version, to: t.version, severity: "low" });
    }
  }

  const sp = source.policies ?? {};
  const tp = target.policies ?? {};
  for (const key of union(sp, tp)) {
    const s = sp[key];
    const t = tp[key];
    const table = (s ?? t)!.table;
    if (!onBothSides(table)) continue;
    // A missing or different policy changes who can see or write which rows.
    if (s && !t) items.push({ kind: "policy_missing", table, name: s.name, severity: "high" });
    else if (!s && t) items.push({ kind: "policy_extra", table, name: t.name, severity: "medium" });
    else if (s && t && s.definition !== t.definition) {
      items.push({ kind: "policy_changed", table, name: s.name, from: s.definition, to: t.definition, severity: "high" });
    }
  }

  for (const key of union(source.tables, target.tables)) {
    const s = source.tables[key]?.rowSecurity;
    const t = target.tables[key]?.rowSecurity;
    if (!s || !t) continue;
    const from = rlsState(s);
    const to = rlsState(t);
    if (from === to) continue;
    // Weaker on the target (off, or not forced for the owner) exposes rows the source protects.
    const weaker = RLS_RANK[to] < RLS_RANK[from];
    items.push({ kind: "row_security_changed", table: key, from, to, severity: weaker ? "high" : "medium" });
  }

  return items;
}

const RLS_RANK = { off: 0, on: 1, forced: 2 } as const;

function rlsState(r: NonNullable<Table["rowSecurity"]>): keyof typeof RLS_RANK {
  return !r.enabled ? "off" : r.forced ? "forced" : "on";
}

function hasRelation(schema: Schema, key: string): boolean {
  return !!schema.tables[key] || !!schema.views?.[key];
}

function union(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
}
