import type { DriftReport } from "../diff/types.js";
import type { Column, Schema, Table } from "../introspect/types.js";
import { ident, tableRef } from "../sql/ident.js";

/** One raw DDL statement that fixes (part of) the drift, before safe rewriting. */
export interface DesiredChange {
  title: string;
  sql: string;
  phase: "expand" | "contract";
  /** A comment for a human instead of SQL (e.g. primary key changes). */
  manual?: boolean;
}

/**
 * Turns a DriftReport into the plain DDL that makes TARGET match SOURCE.
 * The output is intentionally naive ("ALTER TABLE ... TYPE bigint"); the safe-rewrite
 * engine (F6) turns it into non-blocking steps afterwards. Keeping the two separate
 * means each is simple and testable on its own.
 */
export function desiredChanges(drift: DriftReport, source: Schema): DesiredChange[] {
  const creates: DesiredChange[] = [];
  const changes: DesiredChange[] = [];
  const foreignKeys: DesiredChange[] = [];
  const contract: DesiredChange[] = [];

  const newTables = new Set(drift.items.filter((i) => i.kind === "table_missing").map((i) => (i as { table: string }).table));

  for (const item of drift.items) {
    switch (item.kind) {
      case "table_missing": {
        const t = source.tables[item.table]!;
        creates.push({ title: `Create table ${item.table}`, sql: createTable(t), phase: "expand" });
        for (const idx of Object.values(t.indexes)) {
          if (t.constraints[idx.name]) continue; // created by its constraint
          changes.push({ title: `Create index ${idx.name}`, sql: idx.definition, phase: "expand" });
        }
        // FKs last, so every referenced table exists by then.
        for (const c of Object.values(t.constraints).filter((c) => c.type === "foreign_key")) {
          foreignKeys.push({ title: `Add foreign key ${c.name}`, sql: `ALTER TABLE ${tableRef(item.table)} ADD CONSTRAINT ${ident(c.name)} ${c.definition}`, phase: "expand" });
        }
        break;
      }
      case "table_extra":
        contract.push({ title: `Drop extra table ${item.table}`, sql: `DROP TABLE ${tableRef(item.table)}`, phase: "contract" });
        break;

      case "column_missing": {
        const c = source.tables[item.table]!.columns[item.column]!;
        changes.push({ title: `Add column ${item.table}.${item.column}`, sql: `ALTER TABLE ${tableRef(item.table)} ADD COLUMN ${columnDef(c)}`, phase: "expand" });
        break;
      }
      case "column_extra":
        contract.push({ title: `Drop extra column ${item.table}.${item.column}`, sql: `ALTER TABLE ${tableRef(item.table)} DROP COLUMN ${ident(item.column)}`, phase: "contract" });
        break;
      case "column_type_changed":
        changes.push({ title: `Change ${item.table}.${item.column} back to ${item.from}`, sql: `ALTER TABLE ${tableRef(item.table)} ALTER COLUMN ${ident(item.column)} TYPE ${item.from}`, phase: "expand" });
        break;
      case "column_nullability_changed":
        changes.push({
          title: item.from ? `Allow NULL in ${item.table}.${item.column}` : `Make ${item.table}.${item.column} NOT NULL`,
          sql: `ALTER TABLE ${tableRef(item.table)} ALTER COLUMN ${ident(item.column)} ${item.from ? "DROP NOT NULL" : "SET NOT NULL"}`,
          phase: "expand",
        });
        break;
      case "column_default_changed":
        changes.push({
          title: `Restore default of ${item.table}.${item.column}`,
          sql: `ALTER TABLE ${tableRef(item.table)} ALTER COLUMN ${ident(item.column)} ${item.from === null ? "DROP DEFAULT" : `SET DEFAULT ${item.from}`}`,
          phase: "expand",
        });
        break;

      case "primary_key_changed":
        changes.push({
          title: `Primary key of ${item.table} differs`,
          sql: `-- MANUAL: primary key of ${item.table} is (${item.to?.join(", ") ?? "none"}) but should be (${item.from?.join(", ") ?? "none"}). Changing a primary key needs an application-aware plan.`,
          phase: "expand",
          manual: true,
        });
        break;

      case "index_missing":
        if (!newTables.has(item.table)) changes.push({ title: `Create index ${item.name}`, sql: item.definition, phase: "expand" });
        break;
      case "index_extra":
        changes.push({ title: `Drop extra index ${item.name}`, sql: `DROP INDEX ${ident(item.name)}`, phase: "expand" });
        break;
      case "index_changed": {
        const def = source.tables[item.table]!.indexes[item.name]!.definition;
        // Drop + re-create: a short window without the index (it's not a constraint).
        changes.push({ title: `Rebuild index ${item.name}`, sql: `DROP INDEX ${ident(item.name)};\n${def}`, phase: "expand" });
        break;
      }

      case "constraint_missing":
        if (!newTables.has(item.table)) {
          changes.push({ title: `Add constraint ${item.name}`, sql: `ALTER TABLE ${tableRef(item.table)} ADD CONSTRAINT ${ident(item.name)} ${item.definition}`, phase: "expand" });
        }
        break;
      case "constraint_extra":
        changes.push({ title: `Drop extra constraint ${item.name}`, sql: `ALTER TABLE ${tableRef(item.table)} DROP CONSTRAINT ${ident(item.name)}`, phase: "expand" });
        break;
      case "constraint_changed": {
        const t = tableRef(item.table);
        const onlyValidation = item.from === item.to.replace(/\s+NOT VALID$/, "");
        changes.push(
          onlyValidation
            ? { title: `Validate constraint ${item.name}`, sql: `ALTER TABLE ${t} VALIDATE CONSTRAINT ${ident(item.name)}`, phase: "expand" }
            : { title: `Replace constraint ${item.name}`, sql: `ALTER TABLE ${t} DROP CONSTRAINT ${ident(item.name)};\nALTER TABLE ${t} ADD CONSTRAINT ${ident(item.name)} ${item.from}`, phase: "expand" },
        );
        break;
      }

      case "sequence_missing": {
        const s = source.sequences[item.sequence]!;
        if (isIdentitySequence(item.sequence, source, newTables)) break; // created by its identity column
        changes.push({
          title: `Create sequence ${item.sequence}`,
          sql: `CREATE SEQUENCE ${tableRef(item.sequence)} AS ${s.dataType} INCREMENT BY ${s.increment} MINVALUE ${s.minValue} MAXVALUE ${s.maxValue}${s.cycle ? " CYCLE" : ""}`,
          phase: "expand",
        });
        break;
      }
      case "sequence_extra":
        contract.push({ title: `Drop extra sequence ${item.sequence}`, sql: `DROP SEQUENCE ${tableRef(item.sequence)}`, phase: "contract" });
        break;
      case "sequence_changed": {
        const s = source.sequences[item.sequence]!;
        const clause: Record<string, string> = {
          dataType: `AS ${s.dataType}`,
          increment: `INCREMENT BY ${s.increment}`,
          minValue: `MINVALUE ${s.minValue}`,
          maxValue: `MAXVALUE ${s.maxValue}`,
          cycle: s.cycle ? "CYCLE" : "NO CYCLE",
        };
        changes.push({ title: `Restore ${item.field} of sequence ${item.sequence}`, sql: `ALTER SEQUENCE ${tableRef(item.sequence)} ${clause[item.field]}`, phase: "expand" });
        break;
      }

      case "possible_rename":
        // Advisory only. The missing/extra column items produce add + (contract) drop.
        break;
    }
  }

  return [...creates, ...changes, ...foreignKeys, ...contract];
}

function createTable(t: Table): string {
  const cols = Object.values(t.columns)
    .sort((a, b) => a.position - b.position)
    .map((c) => `  ${columnDef(c)}`);
  // Non-FK constraints inline: the table is new and empty, so there is nothing to scan.
  const constraints = Object.values(t.constraints)
    .filter((c) => c.type !== "foreign_key")
    .map((c) => `  CONSTRAINT ${ident(c.name)} ${c.definition}`);
  return `CREATE TABLE ${tableRef(`${t.schema}.${t.name}`)} (\n${[...cols, ...constraints].join(",\n")}\n)`;
}

function columnDef(c: Column): string {
  const parts = [ident(c.name), c.type];
  if (c.identity) parts.push(`GENERATED ${c.identity.toUpperCase()} AS IDENTITY`);
  else if (c.default !== null) parts.push(`DEFAULT ${c.default}`);
  if (!c.nullable) parts.push("NOT NULL");
  return parts.join(" ");
}

/** Identity columns own a sequence named <table>_<column>_seq; creating the table creates it. */
function isIdentitySequence(sequence: string, source: Schema, newTables: Set<string>): boolean {
  for (const key of newTables) {
    const t = source.tables[key]!;
    for (const c of Object.values(t.columns)) {
      if (c.identity && `${t.schema}.${t.name}_${c.name}_seq` === sequence) return true;
    }
  }
  return false;
}
