import type { Schema } from "../introspect/types.js";
import { ident, tableRef } from "../sql/ident.js";
import { rangeVarName, stringList, type AstNode, type ParsedStatement } from "../sql/parse.js";

export type Reversibility = "reversible" | "reversible-with-backfill" | "data-lossy" | "unknown";

export interface ReversibilityResult {
  reversibility: Reversibility;
  /** SQL that undoes the statement, or null if none can be generated. */
  rollbackSql: string | null;
  reason: string;
}

const r = (reversibility: Reversibility, rollbackSql: string | null, reason: string): ReversibilityResult => ({
  reversibility,
  rollbackSql,
  reason,
});

/**
 * F11: can this statement be undone, and how?
 *  - reversible:               undo SQL exists and restores the previous state
 *  - reversible-with-backfill: undo SQL exists but may lose precision/new data (e.g. type change)
 *  - data-lossy:               data is destroyed; only a backup can bring it back
 * `schema` is the state BEFORE the statement; it supplies old defaults, types and definitions.
 */
export function classifyReversibility(stmt: ParsedStatement, schema?: Schema): ReversibilityResult {
  const n = stmt.node;
  switch (stmt.type) {
    case "IndexStmt":
      return n.idxname
        ? r("reversible", `DROP INDEX CONCURRENTLY IF EXISTS ${ident(n.idxname)}`, "Dropping the new index restores the previous state.")
        : r("reversible", null, "Reversible, but the index is unnamed, so its generated name must be looked up first.");

    case "CreateStmt":
      return r("reversible", `DROP TABLE ${tableRef(rangeVarName(n.relation))}`, "The table is new; dropping it removes only rows written since.");

    case "CreateSeqStmt":
      return r("reversible", `DROP SEQUENCE ${tableRef(rangeVarName(n.sequence))}`, "The sequence is new.");

    case "RenameStmt": {
      const t = tableRef(rangeVarName(n.relation));
      if (n.renameType === "OBJECT_COLUMN") return r("reversible", `ALTER TABLE ${t} RENAME COLUMN ${ident(n.newname)} TO ${ident(n.subname)}`, "Rename back.");
      if (n.renameType === "OBJECT_TABLE") return r("reversible", `ALTER TABLE ${ident(n.newname)} RENAME TO ${ident(n.relation.relname)}`, "Rename back.");
      return r("unknown", null, "Rename of an object type DriftGuard doesn't classify.");
    }

    case "DropStmt": {
      const names: string[] = (n.objects ?? []).map((o: AstNode) => stringList(o.List?.items).join("."));
      if (n.removeType === "OBJECT_INDEX") {
        const defs = names.map((name) => findIndexDefinition(name, schema));
        return defs.every(Boolean)
          ? r("reversible", defs.map((d) => d!.replace(/^CREATE (UNIQUE )?INDEX /, (m) => `${m}CONCURRENTLY `)).join(";\n"), "Rebuild the index from its previous definition.")
          : r("reversible", null, "Reversible by re-creating the index, but its definition is unknown without a database connection.");
      }
      if (n.removeType === "OBJECT_TABLE") return r("data-lossy", null, "The table and all its rows are deleted.");
      return r("unknown", null, `DROP ${String(n.removeType).replace("OBJECT_", "")} is not classified.`);
    }

    case "TruncateStmt":
      return r("data-lossy", null, "All rows are deleted.");
    case "DeleteStmt":
      return r("data-lossy", null, "Deleted rows can only be restored from a backup.");
    case "UpdateStmt":
      return r("data-lossy", null, "Previous values are overwritten; they can only be restored from a backup.");

    case "AlterTableStmt": {
      const table = rangeVarName(n.relation);
      const parts = (n.cmds ?? []).map((c: AstNode) => classifyAlterCmd(table, c.AlterTableCmd, schema));
      return combine(parts);
    }

    case "VariableSetStmt":
    case "TransactionStmt":
    case "VacuumStmt":
    case "ClusterStmt":
    case "ReindexStmt":
      return r("reversible", null, "Changes no schema or data; nothing to undo.");

    default:
      return r("unknown", null, `${stmt.type} is not classified; review it manually.`);
  }
}

function classifyAlterCmd(table: string, cmd: AstNode, schema?: Schema): ReversibilityResult {
  const t = tableRef(table);
  const before = schema?.tables[table];
  const col = before?.columns[cmd.name];

  switch (cmd.subtype) {
    case "AT_AddColumn":
      return r("reversible", `ALTER TABLE ${t} DROP COLUMN ${ident(cmd.def.ColumnDef.colname)}`, "The column is new; dropping it loses only values written since.");
    case "AT_DropColumn":
      return r("data-lossy", null, `Column ${cmd.name} and its data are deleted.`);
    case "AT_AlterColumnType":
      return col
        ? r("reversible-with-backfill", `ALTER TABLE ${t} ALTER COLUMN ${ident(cmd.name)} TYPE ${col.type}`, `Changing back to ${col.type} can fail or lose precision for values written since.`)
        : r("reversible-with-backfill", null, "Changing the type back needs the previous type (unknown without a database connection).");
    case "AT_SetNotNull":
      return r("reversible", `ALTER TABLE ${t} ALTER COLUMN ${ident(cmd.name)} DROP NOT NULL`, "Drop the NOT NULL again.");
    case "AT_DropNotNull":
      return r("reversible-with-backfill", `ALTER TABLE ${t} ALTER COLUMN ${ident(cmd.name)} SET NOT NULL`, "Fails if NULLs were written in the meantime; backfill them first.");
    case "AT_ColumnDefault":
      if (!before) return r("reversible", null, "Restoring the old default needs the previous schema.");
      return col?.default
        ? r("reversible", `ALTER TABLE ${t} ALTER COLUMN ${ident(cmd.name)} SET DEFAULT ${col.default}`, "Restore the previous default.")
        : r("reversible", `ALTER TABLE ${t} ALTER COLUMN ${ident(cmd.name)} DROP DEFAULT`, "There was no default before.");
    case "AT_AddConstraint": {
      const name = cmd.def.Constraint.conname;
      return name
        ? r("reversible", `ALTER TABLE ${t} DROP CONSTRAINT ${ident(name)}`, "Drop the new constraint.")
        : r("reversible", null, "Reversible, but the constraint is unnamed; look up its generated name first.");
    }
    case "AT_ValidateConstraint":
      return r("reversible", null, "Validation changes no data; nothing to undo.");
    case "AT_DropConstraint": {
      const def = before?.constraints[cmd.name]?.definition;
      return def
        ? r("reversible", `ALTER TABLE ${t} ADD CONSTRAINT ${ident(cmd.name)} ${def}`, "Re-create the constraint from its previous definition (it will re-validate existing rows).")
        : r("reversible", null, "Re-creating the constraint needs its previous definition.");
    }
    default:
      return r("unknown", null, `${cmd.subtype} is not classified.`);
  }
}

/** Several sub-commands: the worst class wins; rollbacks run in reverse order. */
function combine(parts: ReversibilityResult[]): ReversibilityResult {
  const order: Reversibility[] = ["reversible", "reversible-with-backfill", "unknown", "data-lossy"];
  const worst = parts.reduce((a, b) => (order.indexOf(b.reversibility) > order.indexOf(a.reversibility) ? b : a));
  const rollbacks = parts.map((p) => p.rollbackSql);
  return {
    reversibility: worst.reversibility,
    rollbackSql: rollbacks.every((x) => x !== null) ? [...rollbacks].reverse().join(";\n") : null,
    reason: parts.map((p) => p.reason).join(" "),
  };
}

function findIndexDefinition(name: string, schema?: Schema): string | undefined {
  const bare = name.split(".").at(-1)!;
  for (const t of Object.values(schema?.tables ?? {})) if (t.indexes[bare]) return t.indexes[bare].definition;
  return undefined;
}
