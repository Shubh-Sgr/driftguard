import type { Column, Schema, Table } from "../../src/introspect/types.js";

// Small builders so each test only spells out what it cares about.

export function col(name: string, type: string, extra: Partial<Column> = {}): Column {
  return { name, type, nullable: true, default: null, identity: null, position: 1, ...extra };
}

export function table(name: string, columns: Column[], extra: Partial<Table> = {}): Table {
  return {
    schema: "public",
    name,
    columns: Object.fromEntries(columns.map((c, i) => [c.name, { ...c, position: i + 1 }])),
    primaryKey: null,
    indexes: {},
    constraints: {},
    estimatedRows: 0,
    totalBytes: 0,
    ...extra,
  };
}

export function schema(...tables: Table[]): Schema {
  return { tables: Object.fromEntries(tables.map((t) => [`public.${t.name}`, t])), sequences: {} };
}

/** Deep copy so a test can mutate the "target" without touching the "source". */
export const clone = <T>(value: T): T => structuredClone(value);
