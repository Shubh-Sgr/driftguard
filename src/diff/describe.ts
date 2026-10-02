import type { DriftItem } from "./types.js";

/** One drift item as a human-readable sentence (CLI output and shadow-run feedback). */
export function describeDrift(i: DriftItem): string {
  switch (i.kind) {
    case "table_missing": return `table ${i.table} is missing on target`;
    case "table_extra": return `table ${i.table} exists only on target`;
    case "column_missing": return `column ${i.table}.${i.column} (${i.type}) is missing on target`;
    case "column_extra": return `column ${i.table}.${i.column} (${i.type}) exists only on target`;
    case "column_type_changed": return `column ${i.table}.${i.column}: ${i.from} -> ${i.to}`;
    case "column_nullability_changed": return `column ${i.table}.${i.column}: ${i.from ? "NULL" : "NOT NULL"} -> ${i.to ? "NULL" : "NOT NULL"}`;
    case "column_default_changed": return `column ${i.table}.${i.column} default: ${i.from ?? "none"} -> ${i.to ?? "none"}`;
    case "primary_key_changed": return `primary key of ${i.table}: (${i.from?.join(", ") ?? "none"}) -> (${i.to?.join(", ") ?? "none"})`;
    case "index_missing": return `index ${i.name} on ${i.table} is missing on target`;
    case "index_extra": return `index ${i.name} on ${i.table} exists only on target`;
    case "index_changed": return `index ${i.name} on ${i.table} differs:\n             source: ${i.from}\n             target: ${i.to}`;
    case "constraint_missing": return `constraint ${i.name} on ${i.table} is missing on target: ${i.definition}`;
    case "constraint_extra": return `constraint ${i.name} on ${i.table} exists only on target: ${i.definition}`;
    case "constraint_changed": return `constraint ${i.name} on ${i.table} differs:\n             source: ${i.from}\n             target: ${i.to}`;
    case "sequence_missing": return `sequence ${i.sequence} is missing on target`;
    case "sequence_extra": return `sequence ${i.sequence} exists only on target`;
    case "sequence_changed": return `sequence ${i.sequence} ${i.field}: ${i.from} -> ${i.to}`;
    case "view_missing": return `${i.materialized ? "materialized view" : "view"} ${i.name} is missing on target`;
    case "view_extra": return `${i.materialized ? "materialized view" : "view"} ${i.name} exists only on target`;
    case "view_changed": return `view ${i.name} has a different definition on target`;
    case "function_missing": return `function ${i.name} is missing on target`;
    case "function_extra": return `function ${i.name} exists only on target`;
    case "function_changed": return `function ${i.name} has a different definition on target`;
    case "trigger_missing": return `trigger ${i.name} on ${i.table} is missing on target`;
    case "trigger_extra": return `trigger ${i.name} on ${i.table} exists only on target`;
    case "trigger_changed": return `trigger ${i.name} on ${i.table} differs: ${i.from} -> ${i.to}`;
    case "enum_missing": return `enum type ${i.name} is missing on target`;
    case "enum_extra": return `enum type ${i.name} exists only on target`;
    case "enum_changed": return `enum type ${i.name} labels: (${i.from.join(", ")}) -> (${i.to.join(", ")})`;
    case "extension_missing": return `extension ${i.name} is missing on target`;
    case "extension_extra": return `extension ${i.name} exists only on target`;
    case "extension_changed": return `extension ${i.name} version: ${i.from} -> ${i.to}`;
    case "policy_missing": return `row-level security policy ${i.name} on ${i.table} is missing on target`;
    case "policy_extra": return `row-level security policy ${i.name} on ${i.table} exists only on target`;
    case "policy_changed": return `row-level security policy ${i.name} on ${i.table} differs:\n             source: ${i.from}\n             target: ${i.to}`;
    case "row_security_changed": return `row-level security on ${i.table}: ${i.from} -> ${i.to}`;
    case "possible_rename": return `(hint) ${i.table}.${i.from} -> ${i.to} might be a rename; review before dropping anything`;
  }
}
