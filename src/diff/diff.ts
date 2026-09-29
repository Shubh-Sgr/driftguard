import type { Column, Schema, Table } from "../introspect/types.js";
import { isWideningTypeChange } from "./typeChange.js";
import { driftItemKey, type DriftItem, type DriftReport, type Severity } from "./types.js";

/**
 * Compares two schemas and lists every difference. Pure: no I/O, no clock, no
 * randomness. The same inputs always give the same (sorted) output, which is what
 * makes it easy to unit-test and safe to reuse from the CLI, MCP server and evals.
 */
export function diffSchemas(source: Schema, target: Schema): DriftReport {
  const items: DriftItem[] = [];

  for (const key of union(source.tables, target.tables)) {
    const s = source.tables[key];
    const t = target.tables[key];
    if (s && !t) items.push({ kind: "table_missing", table: key, severity: "high" });
    // An extra table breaks nothing in the app, but it's unexpected state worth reviewing.
    else if (!s && t) items.push({ kind: "table_extra", table: key, severity: "medium" });
    else if (s && t) items.push(...diffTable(key, s, t));
  }

  for (const key of union(source.sequences, target.sequences)) {
    const s = source.sequences[key];
    const t = target.sequences[key];
    if (s && !t) items.push({ kind: "sequence_missing", sequence: key, severity: "medium" });
    else if (!s && t) items.push({ kind: "sequence_extra", sequence: key, severity: "low" });
    else if (s && t) {
      for (const field of ["dataType", "increment", "minValue", "maxValue", "cycle"] as const) {
        if (s[field] !== t[field]) {
          items.push({
            kind: "sequence_changed",
            sequence: key,
            field,
            from: String(s[field]),
            to: String(t[field]),
            severity: "low",
          });
        }
      }
    }
  }

  // Sort so output order never depends on catalog/hash-map iteration order.
  items.sort((a, b) => driftItemKey(a).localeCompare(driftItemKey(b)));

  const summary: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const item of items) summary[item.severity]++;

  // possible_rename is advisory; on its own it doesn't make schemas different.
  const identical = items.every((i) => i.kind === "possible_rename");
  return { identical, summary, items };
}

function diffTable(table: string, s: Table, t: Table): DriftItem[] {
  const items: DriftItem[] = [];
  const missing: Column[] = [];
  const extra: Column[] = [];

  for (const name of union(s.columns, t.columns)) {
    const sc = s.columns[name];
    const tc = t.columns[name];
    if (sc && !tc) {
      missing.push(sc);
      items.push({ kind: "column_missing", table, column: name, type: sc.type, severity: "high" });
    } else if (!sc && tc) {
      extra.push(tc);
      items.push({
        kind: "column_extra",
        table,
        column: name,
        type: tc.type,
        // An extra NOT NULL column without a default makes the app's INSERTs fail.
        severity: !tc.nullable && tc.default === null && tc.identity === null ? "high" : "medium",
      });
    } else if (sc && tc) {
      items.push(...diffColumn(table, sc, tc));
    }
  }

  // Advisory: exactly one missing and one extra column of the same type looks like a rename.
  if (missing.length === 1 && extra.length === 1 && missing[0]!.type === extra[0]!.type) {
    items.push({ kind: "possible_rename", table, from: missing[0]!.name, to: extra[0]!.name, severity: "low" });
  }

  if (JSON.stringify(s.primaryKey) !== JSON.stringify(t.primaryKey)) {
    items.push({ kind: "primary_key_changed", table, from: s.primaryKey, to: t.primaryKey, severity: "high" });
  }

  for (const name of union(s.indexes, t.indexes)) {
    const si = s.indexes[name];
    const ti = t.indexes[name];
    // Indexes that back a constraint (PK, UNIQUE, EXCLUDE — same name) are reported
    // once, as the constraint; otherwise one change would show up as two drift items.
    if (s.constraints[name] || t.constraints[name]) continue;
    // A missing UNIQUE index also removes a uniqueness guarantee, so it's worse than a
    // missing performance index.
    if (si && !ti) {
      items.push({ kind: "index_missing", table, name, definition: si.definition, severity: si.unique ? "medium" : "low" });
    } else if (!si && ti) {
      items.push({ kind: "index_extra", table, name, definition: ti.definition, severity: "low" });
    } else if (si && ti && si.definition !== ti.definition) {
      items.push({ kind: "index_changed", table, name, from: si.definition, to: ti.definition, severity: si.unique || ti.unique ? "medium" : "low" });
    } else if (si && ti && si.valid !== ti.valid) {
      // Same definition but INVALID on one side = a failed CREATE INDEX CONCURRENTLY.
      items.push({ kind: "index_changed", table, name, from: validity(si.valid), to: validity(ti.valid), severity: "medium" });
    }
  }

  for (const name of union(s.constraints, t.constraints)) {
    const sc = s.constraints[name];
    const tc = t.constraints[name];
    if (sc?.type === "primary_key" || tc?.type === "primary_key") continue;
    if (sc && !tc) {
      // Missing FK/CHECK/UNIQUE = the target accepts data the source would reject.
      items.push({ kind: "constraint_missing", table, name, definition: sc.definition, severity: "high" });
    } else if (!sc && tc) {
      items.push({ kind: "constraint_extra", table, name, definition: tc.definition, severity: "medium" });
    } else if (sc && tc && sc.definition !== tc.definition) {
      // Differing only by NOT VALID means the rule applies to new rows but old rows
      // weren't checked yet — less severe than a different rule.
      const onlyValidation = stripNotValid(sc.definition) === stripNotValid(tc.definition);
      items.push({ kind: "constraint_changed", table, name, from: sc.definition, to: tc.definition, severity: onlyValidation ? "medium" : "high" });
    }
  }

  return items;
}

function diffColumn(table: string, s: Column, t: Column): DriftItem[] {
  const items: DriftItem[] = [];
  const column = s.name;

  if (s.type !== t.type) {
    // "Widening" here means target holds everything source can: the app is safe.
    const severity = isWideningTypeChange(s.type, t.type) ? "medium" : "high";
    items.push({ kind: "column_type_changed", table, column, from: s.type, to: t.type, severity });
  }
  if (s.nullable !== t.nullable) {
    // Target stricter (NOT NULL) than source: inserts the app expects to work will fail.
    // Target looser: the app may start reading NULLs it never expected.
    const severity = !t.nullable ? "high" : "medium";
    items.push({ kind: "column_nullability_changed", table, column, from: s.nullable, to: t.nullable, severity });
  }
  if (s.default !== t.default) {
    items.push({ kind: "column_default_changed", table, column, from: s.default, to: t.default, severity: "medium" });
  }
  return items;
}

/** Sorted union of the keys of two records. */
function union(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
}

const validity = (valid: boolean) => (valid ? "VALID" : "INVALID");
const stripNotValid = (def: string) => def.replace(/\s+NOT VALID$/, "");
