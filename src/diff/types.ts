export type Severity = "high" | "medium" | "low";

// Direction convention used everywhere: SOURCE is the reference (desired state),
// TARGET is the database being checked. "missing" = in source, not in target;
// "extra" = in target, not in source.
export type DriftItem =
  | { kind: "table_missing"; table: string; severity: Severity }
  | { kind: "table_extra"; table: string; severity: Severity }
  | { kind: "column_missing"; table: string; column: string; type: string; severity: Severity }
  | { kind: "column_extra"; table: string; column: string; type: string; severity: Severity }
  | { kind: "column_type_changed"; table: string; column: string; from: string; to: string; severity: Severity }
  | { kind: "column_nullability_changed"; table: string; column: string; from: boolean; to: boolean; severity: Severity }
  | { kind: "column_default_changed"; table: string; column: string; from: string | null; to: string | null; severity: Severity }
  | { kind: "primary_key_changed"; table: string; from: string[] | null; to: string[] | null; severity: Severity }
  | { kind: "index_missing"; table: string; name: string; definition: string; severity: Severity }
  | { kind: "index_extra"; table: string; name: string; definition: string; severity: Severity }
  | { kind: "index_changed"; table: string; name: string; from: string; to: string; severity: Severity }
  | { kind: "constraint_missing"; table: string; name: string; definition: string; severity: Severity }
  | { kind: "constraint_extra"; table: string; name: string; definition: string; severity: Severity }
  | { kind: "constraint_changed"; table: string; name: string; from: string; to: string; severity: Severity }
  | { kind: "sequence_missing"; sequence: string; severity: Severity }
  | { kind: "sequence_extra"; sequence: string; severity: Severity }
  | { kind: "sequence_changed"; sequence: string; field: string; from: string; to: string; severity: Severity }
  // Views, functions/procedures, triggers, enum types, extensions and row-level security.
  // `name` is the object's key: "schema.view", "schema.fn(args)", "schema.type", "extension".
  | { kind: "view_missing"; name: string; materialized: boolean; severity: Severity }
  | { kind: "view_extra"; name: string; materialized: boolean; severity: Severity }
  | { kind: "view_changed"; name: string; from: string; to: string; severity: Severity }
  | { kind: "function_missing"; name: string; severity: Severity }
  | { kind: "function_extra"; name: string; severity: Severity }
  | { kind: "function_changed"; name: string; from: string; to: string; severity: Severity }
  | { kind: "trigger_missing"; table: string; name: string; severity: Severity }
  | { kind: "trigger_extra"; table: string; name: string; severity: Severity }
  | { kind: "trigger_changed"; table: string; name: string; from: string; to: string; severity: Severity }
  | { kind: "enum_missing"; name: string; severity: Severity }
  | { kind: "enum_extra"; name: string; severity: Severity }
  | { kind: "enum_changed"; name: string; from: string[]; to: string[]; severity: Severity }
  | { kind: "extension_missing"; name: string; severity: Severity }
  | { kind: "extension_extra"; name: string; severity: Severity }
  | { kind: "extension_changed"; name: string; from: string; to: string; severity: Severity }
  | { kind: "policy_missing"; table: string; name: string; severity: Severity }
  | { kind: "policy_extra"; table: string; name: string; severity: Severity }
  | { kind: "policy_changed"; table: string; name: string; from: string; to: string; severity: Severity }
  | { kind: "row_security_changed"; table: string; from: string; to: string; severity: Severity }
  // Advisory only: a missing + extra column pair with the same type MIGHT be a rename.
  // We never act on it — a wrong rename guess could lose data.
  | { kind: "possible_rename"; table: string; from: string; to: string; severity: Severity };

export type DriftKind = DriftItem["kind"];

export interface DriftReport {
  identical: boolean;
  summary: Record<Severity, number>;
  items: DriftItem[];
}

/**
 * A stable identity for a drift item, used for sorting and by the eval suite to
 * match found items against expected ones.
 */
export function driftItemKey(item: DriftItem): string {
  switch (item.kind) {
    case "table_missing":
    case "table_extra":
    case "primary_key_changed":
      return `${item.kind}:${item.table}`;
    case "column_missing":
    case "column_extra":
    case "column_type_changed":
    case "column_nullability_changed":
    case "column_default_changed":
      return `${item.kind}:${item.table}.${item.column}`;
    case "index_missing":
    case "index_extra":
    case "index_changed":
    case "constraint_missing":
    case "constraint_extra":
    case "constraint_changed":
      return `${item.kind}:${item.table}.${item.name}`;
    case "sequence_missing":
    case "sequence_extra":
      return `${item.kind}:${item.sequence}`;
    case "sequence_changed":
      return `${item.kind}:${item.sequence}.${item.field}`;
    case "view_missing":
    case "view_extra":
    case "view_changed":
    case "function_missing":
    case "function_extra":
    case "function_changed":
    case "enum_missing":
    case "enum_extra":
    case "enum_changed":
    case "extension_missing":
    case "extension_extra":
    case "extension_changed":
      return `${item.kind}:${item.name}`;
    case "trigger_missing":
    case "trigger_extra":
    case "trigger_changed":
    case "policy_missing":
    case "policy_extra":
    case "policy_changed":
      return `${item.kind}:${item.table}.${item.name}`;
    case "row_security_changed":
      return `${item.kind}:${item.table}`;
    case "possible_rename":
      return `${item.kind}:${item.table}.${item.from}->${item.to}`;
  }
}
