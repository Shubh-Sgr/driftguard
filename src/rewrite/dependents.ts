import type { Schema, Table } from "../introspect/types.js";
import { ident, tableRef } from "../sql/ident.js";
import { parseSql, rangeVarName, scanSql, stringList, type AstNode, type SqlToken } from "../sql/parse.js";
import type { RewriteStep } from "./rewrite.js";

/** What the ALTER TYPE expand/contract needs to do with the objects that use the column. */
export interface CarriedOver {
  /** Builds copies of the indexes and constraints on the new column (before the swap). */
  build: RewriteStep[];
  /** Runs inside the swap transaction: drop each original, give its copy the original name. */
  swap: string[];
  /** Objects PgVouch doesn't re-create automatically; a human has to. */
  manual: string[];
}

/**
 * The type-change rewrite swaps in a NEW column. Indexes and constraints stay attached to the
 * old one (renamed <col>_old), so without this the result would silently lose them: found by a
 * shadow run where transactions_merchant_id_fkey ended up on merchant_id_old.
 *
 * Copies are built with the non-blocking patterns (index CONCURRENTLY, FK/CHECK NOT VALID +
 * VALIDATE, UNIQUE via a concurrent index + USING INDEX). At the swap the originals are
 * dropped and the copies take their names, so the schema ends up exactly as before.
 * Primary keys, exclusion constraints and foreign keys from other tables stay manual.
 */
export async function carryOverDependents(schema: Schema, key: string, column: string, newColumn: string): Promise<CarriedOver> {
  const table = schema.tables[key]!;
  const t = tableRef(key);
  const out: CarriedOver = { build: [], swap: [], manual: [] };
  const fresh = nameFactory(schema, table);
  const inbound = await inboundForeignKeys(schema, key, column);

  for (const c of Object.values(table.constraints).sort(byName)) {
    const node = await constraintNode(key, c.name, c.definition);
    if (!constraintColumns(node).includes(column)) continue;
    const label = `${c.type.replace("_", " ")} ${c.name}`;

    if (c.type === "foreign_key" || c.type === "check") {
      // For a FK only the first column list is ours; the REFERENCES list belongs to the other table.
      const def = await renameColumn(c.definition, column, newColumn, c.type === "foreign_key");
      if (def === null) {
        out.manual.push(label);
        continue;
      }
      const copy = fresh(`${c.name}_new`);
      out.build.push({
        sql: `ALTER TABLE ${t} ADD CONSTRAINT ${ident(copy)} ${def.replace(/\s+NOT VALID$/, "")} NOT VALID`,
        transactional: true,
        kind: "ddl",
        note: `Copy of ${c.name} on ${newColumn}: instant, checks new rows only.`,
      });
      if (c.validated) {
        out.build.push({ sql: `ALTER TABLE ${t} VALIDATE CONSTRAINT ${ident(copy)}`, transactional: true, kind: "ddl", note: "Checks existing rows without blocking reads or writes." });
      }
      out.swap.push(`ALTER TABLE ${t} DROP CONSTRAINT ${ident(c.name)}`, `ALTER TABLE ${t} RENAME CONSTRAINT ${ident(copy)} TO ${ident(c.name)}`);
      continue;
    }

    // Dropping a UNIQUE that other tables' FKs rely on fails; DEFERRABLE / NULLS NOT DISTINCT
    // don't fit the USING INDEX pattern (and NULLS NOT DISTINCT would reject the old column's NULLs).
    const index = c.type === "unique" && inbound.length === 0 && !/DEFERRABLE|NULLS NOT DISTINCT/i.test(c.definition) ? table.indexes[c.name] : undefined;
    const copy = index ? fresh(`${c.name}_new`) : null;
    const create = index && copy ? await copyIndex(index.definition, copy, column, newColumn) : null;
    if (!create || !copy) {
      out.manual.push(c.type === "unique" && inbound.length ? `${label} (other tables' foreign keys depend on it)` : label);
      continue;
    }
    out.build.push(
      { sql: create, transactional: false, kind: "ddl", note: `Unique index for the copy of ${c.name}, built without blocking writes.` },
      { sql: `ALTER TABLE ${t} ADD CONSTRAINT ${ident(copy)} UNIQUE USING INDEX ${ident(copy)}`, transactional: true, kind: "ddl", note: "Instant: reuses the index built above." },
    );
    // Renaming an index-backed constraint renames its index too.
    out.swap.push(`ALTER TABLE ${t} DROP CONSTRAINT ${ident(c.name)}`, `ALTER TABLE ${t} RENAME CONSTRAINT ${ident(copy)} TO ${ident(c.name)}`);
  }

  for (const idx of Object.values(table.indexes).sort(byName)) {
    if (table.constraints[idx.name]) continue; // handled with its constraint above
    const [stmt] = await parseSql(idx.definition);
    if (!referencedColumns(stmt!.node).includes(column)) continue;
    const copy = fresh(`${idx.name}_new`);
    const create = await copyIndex(idx.definition, copy, column, newColumn);
    if (!create) {
      out.manual.push(`index ${idx.name}`);
      continue;
    }
    out.build.push({ sql: create, transactional: false, kind: "ddl", note: `Copy of ${idx.name} on ${newColumn}, built without blocking writes.` });
    out.swap.push(`DROP INDEX ${qualified(table.schema, idx.name)}`, `ALTER INDEX ${qualified(table.schema, copy)} RENAME TO ${ident(idx.name)}`);
  }

  // After the swap these would point at <col>_old: the referencing tables need their own plan.
  for (const fk of inbound) out.manual.push(`foreign key ${fk} (references this column)`);
  return out;
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

function qualified(schemaName: string, name: string): string {
  return schemaName === "public" ? ident(name) : `${ident(schemaName)}.${ident(name)}`;
}

/** Names that don't collide with existing constraints/indexes or with names handed out earlier. */
function nameFactory(schema: Schema, table: Table): (base: string) => string {
  const used = new Set<string>();
  const taken = (n: string) => used.has(n) || n in table.constraints || Object.values(schema.tables).some((t) => n in t.indexes);
  return (base) => {
    const stem = base.slice(0, 60); // Postgres truncates names to 63 bytes; leave room for a suffix
    let name = stem;
    for (let i = 1; taken(name); i++) name = `${stem}${i}`;
    used.add(name);
    return name;
  };
}

async function constraintNode(key: string, name: string, definition: string): Promise<AstNode> {
  const [stmt] = await parseSql(`ALTER TABLE ${tableRef(key)} ADD CONSTRAINT ${ident(name)} ${definition}`);
  return stmt!.node.cmds[0].AlterTableCmd.def.Constraint;
}

/** Columns of THIS table a constraint uses (not the columns a foreign key points at). */
function constraintColumns(c: AstNode): string[] {
  return [...stringList(c.fk_attrs), ...stringList(c.keys), ...stringList(c.including), ...referencedColumns(c.raw_expr), ...referencedColumns(c.exclusions)];
}

/** Column names in an index definition or expression: plain index columns and column references. */
function referencedColumns(node: AstNode, out: string[] = []): string[] {
  if (node && typeof node === "object") {
    if (typeof node.IndexElem?.name === "string") out.push(node.IndexElem.name);
    const ref = node.ColumnRef?.fields?.at(-1)?.String?.sval;
    if (typeof ref === "string") out.push(ref);
    for (const v of Object.values(node)) referencedColumns(v, out);
  }
  return out;
}

/** "table.constraint" for every foreign key in the schema that references key(column). */
async function inboundForeignKeys(schema: Schema, key: string, column: string): Promise<string[]> {
  const found: string[] = [];
  for (const [tableKey, t] of Object.entries(schema.tables)) {
    for (const c of Object.values(t.constraints)) {
      if (c.type !== "foreign_key") continue;
      const node = await constraintNode(tableKey, c.name, c.definition);
      if (rangeVarName(node.pktable) === key && stringList(node.pk_attrs).includes(column)) found.push(`${tableKey}.${c.name}`);
    }
  }
  return found.sort();
}

/**
 * Renames identifier tokens `from` -> `to` in a catalog definition. With firstGroupOnly, only
 * inside the first parenthesised list (a FK's own columns). Returns null if nothing changed.
 */
async function renameColumn(definition: string, from: string, to: string, firstGroupOnly: boolean): Promise<string | null> {
  const tokens = await scanSql(definition);
  let [first, last] = [0, tokens.length];
  if (firstGroupOnly) {
    first = tokens.findIndex((tk) => tk.text === "(");
    last = closingParen(tokens, first);
  }
  const edits = tokens.slice(first, last).filter((tk) => tk.ident === from).map((tk) => ({ start: tk.start, end: tk.end, text: ident(to) }));
  return edits.length ? applyEdits(definition, edits) : null;
}

/**
 * pg_get_indexdef() output -> CREATE [UNIQUE] INDEX CONCURRENTLY <newName> ... on the new column.
 * Only tokens after USING are renamed (the column list, expressions, INCLUDE and WHERE), never
 * the table name. Returns null if the column doesn't appear there.
 */
async function copyIndex(definition: string, newName: string, from: string, to: string): Promise<string | null> {
  const tokens = await scanSql(definition);
  const index = tokens.findIndex((tk) => tk.text.toUpperCase() === "INDEX");
  const using = tokens.findIndex((tk, i) => i > index && tk.text.toUpperCase() === "USING");
  if (index < 0 || using < 0 || !tokens[index + 1]) return null;
  const renames = tokens.slice(using + 1).filter((tk) => tk.ident === from).map((tk) => ({ start: tk.start, end: tk.end, text: ident(to) }));
  if (renames.length === 0) return null;
  const name = tokens[index + 1]!;
  return applyEdits(definition, [
    { start: tokens[index]!.end, end: tokens[index]!.end, text: " CONCURRENTLY" },
    { start: name.start, end: name.end, text: ident(newName) },
    ...renames,
  ]);
}

function closingParen(tokens: SqlToken[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i]!.text === "(") depth++;
    else if (tokens[i]!.text === ")" && --depth === 0) return i;
  }
  return tokens.length;
}

/** Applies byte-offset edits (token offsets are bytes, not JS string indexes). */
function applyEdits(sql: string, edits: { start: number; end: number; text: string }[]): string {
  const bytes = Buffer.from(sql, "utf8");
  let out = "";
  let pos = 0;
  for (const e of [...edits].sort((a, b) => a.start - b.start)) {
    out += bytes.subarray(pos, e.start).toString("utf8") + e.text;
    pos = e.end;
  }
  return out + bytes.subarray(pos).toString("utf8");
}
