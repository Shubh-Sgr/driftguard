import type { DriftReport } from "../diff/types.js";
import type { Column, Schema, Table, TriggerState } from "../introspect/types.js";
import { ident, quoteLiteral, tableRef } from "../sql/ident.js";

/** One raw DDL statement that fixes (part of) the drift, before safe rewriting. */
export interface DesiredChange {
  title: string;
  sql: string;
  phase: "expand" | "contract";
  /** A comment for a human instead of SQL (e.g. primary key changes). */
  manual?: boolean;
  /**
   * Run exactly as written, as one step. For BEGIN ... COMMIT blocks that replace a
   * trigger or policy atomically (the safe-rewrite pass would split them apart).
   */
  verbatim?: boolean;
}

/**
 * Turns a DriftReport into the plain DDL that makes TARGET match SOURCE.
 * The output is intentionally naive ("ALTER TABLE ... TYPE bigint"); the safe-rewrite
 * engine (F6) turns it into non-blocking steps afterwards. Keeping the two separate
 * means each is simple and testable on its own.
 */
export function desiredChanges(drift: DriftReport, source: Schema): DesiredChange[] {
  // Order matters: extensions and enum types before the tables that use them; functions
  // after the tables (SQL functions are checked against them); then views; triggers need
  // their functions; RLS is switched on only after its policies exist, so there is no
  // moment where RLS is on with no policy (which would block every non-owner).
  const early: DesiredChange[] = [];
  const creates: DesiredChange[] = [];
  const changes: DesiredChange[] = [];
  const foreignKeys: DesiredChange[] = [];
  const functions: DesiredChange[] = [];
  const views: DesiredChange[] = [];
  const triggers: DesiredChange[] = [];
  const policies: DesiredChange[] = [];
  const rls: DesiredChange[] = [];
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
        // Its triggers, policies and row-level security come with it.
        for (const tr of Object.values(source.triggers ?? {}).filter((x) => x.table === item.table)) {
          triggers.push(...createTrigger(tr.definition, tr.table, tr.name, tr.state));
        }
        for (const p of Object.values(source.policies ?? {}).filter((x) => x.table === item.table)) {
          policies.push({ title: `Create policy ${p.name} on ${item.table}`, sql: p.definition, phase: "expand" });
        }
        if (t.rowSecurity?.enabled) rls.push(rowSecurity(item.table, t.rowSecurity.forced ? "forced" : "on"));
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

      case "extension_missing": {
        const e = source.extensions?.[item.name];
        const clause = e ? ` WITH SCHEMA ${ident(e.schema)} VERSION ${quoteLiteral(e.version)}` : "";
        early.push(manual(`Install extension ${item.name}`, `-- MANUAL (needs a privileged role): CREATE EXTENSION IF NOT EXISTS ${ident(item.name)}${clause};`));
        break;
      }
      case "extension_changed":
        early.push(manual(`Update extension ${item.name}`, `-- MANUAL (needs a privileged role; check the extension's upgrade notes): ALTER EXTENSION ${ident(item.name)} UPDATE TO ${quoteLiteral(item.from)};`));
        break;
      case "extension_extra":
        contract.push(manual(`Remove extra extension ${item.name}`, `-- CONTRACT (manual, needs a privileged role): DROP EXTENSION ${ident(item.name)};`, "contract"));
        break;

      case "enum_missing": {
        const labels = source.enums![item.name]!.labels.map(quoteLiteral).join(", ");
        early.push({ title: `Create enum type ${item.name}`, sql: `CREATE TYPE ${tableRef(item.name)} AS ENUM (${labels})`, phase: "expand" });
        break;
      }
      case "enum_changed":
        early.push(...enumLabels(item.name, item.from, item.to));
        break;
      case "enum_extra":
        contract.push({ title: `Drop extra enum type ${item.name}`, sql: `DROP TYPE ${tableRef(item.name)}`, phase: "contract" });
        break;

      case "function_missing":
      case "function_changed":
        // pg_get_functiondef() prints a complete CREATE OR REPLACE statement.
        functions.push({ title: `${item.kind === "function_missing" ? "Create" : "Replace"} function ${item.name}`, sql: source.routines![item.name]!.definition, phase: "expand" });
        break;
      case "function_extra":
        contract.push({ title: `Drop extra function ${item.name}`, sql: `DROP ROUTINE ${routineRef(item.name)}`, phase: "contract" });
        break;

      case "view_missing":
      case "view_changed": {
        const v = source.views![item.name]!;
        const query = v.definition.trim().replace(/;$/, "");
        if (v.materialized) {
          views.push(item.kind === "view_missing"
            ? { title: `Create materialized view ${item.name}`, sql: `CREATE MATERIALIZED VIEW ${tableRef(item.name)} AS ${query}`, phase: "expand" }
            : manual(`Rebuild materialized view ${item.name}`, `-- MANUAL: materialized view ${item.name} differs. Re-create it (DROP + CREATE, then REFRESH) at a quiet time; its dependants must be re-created too.`));
        } else {
          // CREATE OR REPLACE keeps dependent views; it fails (and the shadow run says so)
          // if a column was removed or retyped, which then needs a manual DROP + CREATE.
          views.push({ title: `${item.kind === "view_missing" ? "Create" : "Replace"} view ${item.name}`, sql: `CREATE OR REPLACE VIEW ${tableRef(item.name)} AS ${query}`, phase: "expand" });
        }
        break;
      }
      case "view_extra":
        contract.push({ title: `Drop extra view ${item.name}`, sql: `DROP ${item.materialized ? "MATERIALIZED VIEW" : "VIEW"} ${tableRef(item.name)}`, phase: "contract" });
        break;

      case "trigger_missing": {
        const tr = source.triggers![`${item.table}.${item.name}`]!;
        triggers.push(...createTrigger(tr.definition, item.table, item.name, tr.state));
        break;
      }
      case "trigger_changed": {
        const tr = source.triggers![`${item.table}.${item.name}`]!;
        if (!item.from.startsWith("CREATE")) {
          triggers.push(triggerState(item.table, item.name, tr.state));
        } else {
          // Drop + create in one transaction: never a moment without the trigger.
          const state = tr.state === "enabled" ? [] : [triggerState(item.table, item.name, tr.state).sql];
          triggers.push({
            title: `Replace trigger ${item.name} on ${item.table}`,
            sql: ["BEGIN", `DROP TRIGGER ${ident(item.name)} ON ${tableRef(item.table)}`, tr.definition, ...state, "COMMIT"].join(";\n"),
            phase: "expand",
            verbatim: true,
          });
        }
        break;
      }
      case "trigger_extra":
        contract.push({ title: `Drop extra trigger ${item.name} on ${item.table}`, sql: `DROP TRIGGER ${ident(item.name)} ON ${tableRef(item.table)}`, phase: "contract" });
        break;

      case "policy_missing":
        policies.push({ title: `Create policy ${item.name} on ${item.table}`, sql: source.policies![`${item.table}.${item.name}`]!.definition, phase: "expand" });
        break;
      case "policy_changed":
        // Drop + create in one transaction: never a moment with the wrong access rules.
        policies.push({
          title: `Replace policy ${item.name} on ${item.table}`,
          sql: ["BEGIN", `DROP POLICY ${ident(item.name)} ON ${tableRef(item.table)}`, item.from, "COMMIT"].join(";\n"),
          phase: "expand",
          verbatim: true,
        });
        break;
      case "policy_extra":
        contract.push({ title: `Drop extra policy ${item.name} on ${item.table}`, sql: `DROP POLICY ${ident(item.name)} ON ${tableRef(item.table)}`, phase: "contract" });
        break;
      case "row_security_changed":
        rls.push(rowSecurity(item.table, item.from as "off" | "on" | "forced"));
        break;

      case "possible_rename":
        // Advisory only. The missing/extra column items produce add + (contract) drop.
        break;
    }
  }

  return [...early, ...creates, ...changes, ...foreignKeys, ...functions, ...views, ...triggers, ...policies, ...rls, ...contract];
}

function manual(title: string, sql: string, phase: DesiredChange["phase"] = "expand"): DesiredChange {
  return { title, sql, phase, manual: true };
}

/** "public.fn(integer, text)" -> public.fn(integer, text), quoting the schema and name. */
function routineRef(key: string): string {
  const open = key.indexOf("(");
  return `${tableRef(key.slice(0, open))}${key.slice(open)}`;
}

const TRIGGER_STATE_SQL: Record<TriggerState, string> = { enabled: "ENABLE", disabled: "DISABLE", replica: "ENABLE REPLICA", always: "ENABLE ALWAYS" };

function triggerState(table: string, name: string, state: TriggerState): DesiredChange {
  return { title: `Set trigger ${name} on ${table} to ${state}`, sql: `ALTER TABLE ${tableRef(table)} ${TRIGGER_STATE_SQL[state]} TRIGGER ${ident(name)}`, phase: "expand" };
}

function createTrigger(definition: string, table: string, name: string, state: TriggerState): DesiredChange[] {
  const create: DesiredChange = { title: `Create trigger ${name} on ${table}`, sql: definition, phase: "expand" };
  return state === "enabled" ? [create] : [create, triggerState(table, name, state)];
}

function rowSecurity(table: string, state: "off" | "on" | "forced"): DesiredChange {
  const t = tableRef(table);
  const sql = state === "off"
    ? `ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY`
    : `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY, ${state === "forced" ? "FORCE" : "NO FORCE"} ROW LEVEL SECURITY`;
  return { title: `Set row-level security on ${table} to ${state}`, sql, phase: "expand" };
}

/**
 * Adds the labels the target lacks, each at its position in the source order. Postgres
 * can add enum labels in place but can't remove or reorder them, so a target with extra
 * labels or a different order needs a human (re-create the type).
 */
function enumLabels(key: string, source: string[], target: string[]): DesiredChange[] {
  const extra = target.filter((l) => !source.includes(l));
  const order = target.filter((l) => source.includes(l));
  const sameOrder = order.every((l, i) => i === 0 || source.indexOf(l) > source.indexOf(order[i - 1]!));
  if (extra.length || !sameOrder) {
    return [manual(`Fix enum type ${key}`, `-- MANUAL: enum type ${key} on target has labels the source doesn't, or a different order. Postgres can't remove or reorder enum labels in place; re-create the type and the columns that use it.`)];
  }
  const have = [...target];
  const out: DesiredChange[] = [];
  for (const [i, label] of source.entries()) {
    if (have.includes(label)) continue;
    const before = source.slice(0, i).reverse().find((l) => have.includes(l));
    const after = source.slice(i + 1).find((l) => have.includes(l));
    const where = before !== undefined ? ` AFTER ${quoteLiteral(before)}` : after !== undefined ? ` BEFORE ${quoteLiteral(after)}` : "";
    out.push({ title: `Add label ${label} to enum type ${key}`, sql: `ALTER TYPE ${tableRef(key)} ADD VALUE IF NOT EXISTS ${quoteLiteral(label)}${where}`, phase: "expand" });
    have.splice(before !== undefined ? have.indexOf(before) + 1 : after !== undefined ? have.indexOf(after) : have.length, 0, label);
  }
  return out;
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
