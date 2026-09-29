import type { Schema } from "../introspect/types.js";
import { analyzeParsed } from "../locks/analyze.js";
import { unsafeRuleFor } from "../rewrite/rewrite.js";
import { parseSql, rangeVarName, stringList, type AstNode, type ParsedStatement } from "../sql/parse.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// Statement types a plan may contain. Anything else (DELETE, TRUNCATE, GRANT, COPY,
// DO blocks, BEGIN/COMMIT, CREATE FUNCTION, ...) is rejected outright. DO blocks are
// excluded because their body is opaque PL/pgSQL that could hide any statement.
const ALLOWED = new Set([
  "CreateStmt",
  "AlterTableStmt",
  "IndexStmt",
  "DropStmt",
  "UpdateStmt",
  "CreateSeqStmt",
  "AlterSeqStmt",
  "VariableSetStmt",
]);

/**
 * The guardrail: checks an LLM-written plan against facts, not opinions.
 *  1. Every step parses (Postgres' own parser).
 *  2. Only allow-listed statement types.
 *  3. Every table, column, index and constraint referenced exists in the target —
 *     or is created by an earlier step (catches hallucinated objects).
 *  4. No step does something risky that DriftGuard knows a safe rewrite for.
 */
export async function validatePlanSql(steps: { sql: string }[], target: Schema): Promise<ValidationResult> {
  const errors: string[] = [];
  const parsedSteps: ParsedStatement[][] = [];

  for (const [i, step] of steps.entries()) {
    try {
      parsedSteps.push(await parseSql(step.sql));
    } catch (err) {
      errors.push(`step ${i + 1}: SQL does not parse: ${(err as Error).message}`);
      parsedSteps.push([]);
    }
  }

  const world = new World(target);
  const all: ParsedStatement[] = [];
  for (const [i, stmts] of parsedSteps.entries()) {
    for (const stmt of stmts) {
      const where = `step ${i + 1}`;
      if (!ALLOWED.has(stmt.type)) {
        errors.push(`${where}: ${stmt.type} is not allowed in a migration plan`);
        continue;
      }
      if (stmt.type === "VariableSetStmt" && !["lock_timeout", "statement_timeout"].includes(stmt.node.name)) {
        errors.push(`${where}: only SET lock_timeout / statement_timeout are allowed`);
        continue;
      }
      if (stmt.type === "UpdateStmt" && !stmt.node.whereClause) {
        errors.push(`${where}: UPDATE without WHERE is not allowed; backfill in primary-key ranges`);
        continue; // already rejected; don't report it again in the safety check below
      }
      for (const e of world.apply(stmt)) errors.push(`${where}: ${e}`);
      all.push(stmt);
    }
  }

  // Safety: analyze all statements in order (as the script would run, after SET
  // lock_timeout), so e.g. SET NOT NULL after a validated CHECK is recognised as safe.
  const analysis = analyzeParsed(all, target);
  for (const [k, stmt] of all.entries()) {
    const rule = unsafeRuleFor(stmt, analysis.statements[k]!, target);
    if (rule) errors.push(`unsafe statement "${oneLine(stmt.text)}": use the safe pattern "${rule}" instead`);
  }

  return { valid: errors.length === 0, errors };
}

const oneLine = (s: string) => (s.length > 100 ? `${s.slice(0, 97)}...` : s).replace(/\s+/g, " ");

interface TableState {
  columns: Set<string>;
  constraints: Set<string>;
}

/**
 * A minimal model of the target schema that we update as the plan's statements are
 * "applied", so step 5 may use a column that step 2 adds.
 */
class World {
  private tables = new Map<string, TableState>();
  private indexes = new Set<string>();

  constructor(target: Schema) {
    for (const [key, t] of Object.entries(target.tables)) {
      this.tables.set(key, { columns: new Set(Object.keys(t.columns)), constraints: new Set(Object.keys(t.constraints)) });
      for (const name of Object.keys(t.indexes)) this.indexes.add(name);
    }
  }

  apply(stmt: ParsedStatement): string[] {
    const n = stmt.node;
    switch (stmt.type) {
      case "CreateStmt": {
        const key = rangeVarName(n.relation);
        if (this.tables.has(key)) return n.if_not_exists ? [] : [`table ${key} already exists`];
        const columns = new Set<string>();
        const constraints = new Set<string>();
        for (const el of n.tableElts ?? []) {
          if (el.ColumnDef) columns.add(el.ColumnDef.colname);
          if (el.Constraint?.conname) constraints.add(el.Constraint.conname);
        }
        this.tables.set(key, { columns, constraints });
        return [];
      }
      case "AlterTableStmt":
        return this.alterTable(n);
      case "IndexStmt": {
        const key = rangeVarName(n.relation);
        const errors = this.requireColumns(key, (n.indexParams ?? []).map((p: AstNode) => p.IndexElem?.name).filter(Boolean));
        if (n.idxname && this.indexes.has(n.idxname) && !n.if_not_exists) errors.push(`index ${n.idxname} already exists`);
        if (n.idxname) this.indexes.add(n.idxname);
        return errors;
      }
      case "DropStmt": {
        const names: string[] = (n.objects ?? []).map((o: AstNode) => stringList(o.List?.items).join("."));
        const errors: string[] = [];
        for (const name of names) {
          if (n.removeType === "OBJECT_INDEX") {
            const bare = name.split(".").at(-1)!;
            if (!this.indexes.delete(bare) && !n.missing_ok) errors.push(`index ${name} does not exist`);
          } else if (n.removeType === "OBJECT_TABLE") {
            const key = name.includes(".") ? name : `public.${name}`;
            if (!this.tables.delete(key) && !n.missing_ok) errors.push(`table ${key} does not exist`);
          }
        }
        return errors;
      }
      case "UpdateStmt": {
        const key = rangeVarName(n.relation);
        return this.requireColumns(key, (n.targetList ?? []).map((t: AstNode) => t.ResTarget?.name).filter(Boolean));
      }
      default:
        return [];
    }
  }

  private alterTable(n: AstNode): string[] {
    const key = rangeVarName(n.relation);
    const table = this.tables.get(key);
    if (!table) return [`table ${key} does not exist`];
    const errors: string[] = [];

    for (const { AlterTableCmd: cmd } of n.cmds ?? []) {
      switch (cmd.subtype) {
        case "AT_AddColumn": {
          const name = cmd.def.ColumnDef.colname;
          if (table.columns.has(name)) errors.push(`column ${key}.${name} already exists`);
          table.columns.add(name);
          break;
        }
        case "AT_DropColumn":
          if (!table.columns.delete(cmd.name) && !cmd.missing_ok) errors.push(`column ${key}.${cmd.name} does not exist`);
          break;
        case "AT_AlterColumnType":
        case "AT_SetNotNull":
        case "AT_DropNotNull":
        case "AT_ColumnDefault":
          errors.push(...this.requireColumns(key, [cmd.name]));
          break;
        case "AT_AddConstraint": {
          const c = cmd.def.Constraint;
          if (c.conname && table.constraints.has(c.conname)) errors.push(`constraint ${c.conname} already exists on ${key}`);
          if (c.conname) table.constraints.add(c.conname);
          errors.push(...this.requireColumns(key, [...stringList(c.fk_attrs), ...stringList(c.keys), ...columnRefs(c.raw_expr)]));
          if (c.pktable) errors.push(...this.requireColumns(rangeVarName(c.pktable), stringList(c.pk_attrs)));
          if (c.indexname && !this.indexes.has(c.indexname)) errors.push(`index ${c.indexname} does not exist`);
          break;
        }
        case "AT_ValidateConstraint":
          if (!table.constraints.has(cmd.name)) errors.push(`constraint ${cmd.name} does not exist on ${key}`);
          break;
        case "AT_DropConstraint":
          if (!table.constraints.delete(cmd.name) && !cmd.missing_ok) errors.push(`constraint ${cmd.name} does not exist on ${key}`);
          break;
      }
    }
    return errors;
  }

  private requireColumns(key: string, columns: string[]): string[] {
    const table = this.tables.get(key);
    if (!table) return [`table ${key} does not exist`];
    return columns.filter((c) => !table.columns.has(c)).map((c) => `column ${key}.${c} does not exist`);
  }
}

/** Column names referenced in an expression (e.g. a CHECK). */
function columnRefs(expr: AstNode, out: string[] = []): string[] {
  if (expr && typeof expr === "object") {
    if (expr.ColumnRef) {
      const name = expr.ColumnRef.fields?.at(-1)?.String?.sval;
      if (name) out.push(name);
    }
    for (const v of Object.values(expr)) columnRefs(v, out);
  }
  return out;
}
