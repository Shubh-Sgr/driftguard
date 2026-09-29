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
    case "possible_rename": return `(hint) ${i.table}.${i.from} -> ${i.to} might be a rename; review before dropping anything`;
  }
}
