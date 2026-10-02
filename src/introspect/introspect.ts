import type pg from "pg";
import { ident, tableRef } from "../sql/ident.js";
import {
  tableKey,
  type Constraint,
  type ConstraintType,
  type Schema,
  type Table,
  type TriggerState,
} from "./types.js";

// We read pg_catalog rather than information_schema: information_schema hides
// Postgres-specific details we need (index methods, partial-index predicates,
// NOT VALID constraints, exact type modifiers).
//
// Every query takes the schema list as ONE array parameter ($1::text[]) — no string
// building — and filters with `= ANY($1)`.

const TABLES_SQL = `
  SELECT n.nspname AS schema, c.relname AS name,
         c.reltuples::float8 AS estimated_rows,
         pg_total_relation_size(c.oid)::float8 AS total_bytes,
         c.relrowsecurity AS row_security, c.relforcerowsecurity AS force_row_security
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p')          -- ordinary + partitioned tables
    AND NOT c.relispartition             -- partitions are reported via their parent
    AND n.nspname = ANY($1::text[])`;

const COLUMNS_SQL = `
  SELECT n.nspname AS schema, c.relname AS table_name, a.attname AS name,
         format_type(a.atttypid, a.atttypmod) AS type,  -- keeps modifiers: numeric(12,2)
         NOT a.attnotnull AS nullable,
         pg_get_expr(d.adbin, d.adrelid) AS default_expr,
         a.attidentity AS identity,
         a.attnum AS position
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
    AND a.attnum > 0              -- skip system columns (ctid, xmin, ...)
    AND NOT a.attisdropped        -- dropped columns linger in pg_attribute
    AND n.nspname = ANY($1::text[])`;

const INDEXES_SQL = `
  SELECT n.nspname AS schema, t.relname AS table_name, i.relname AS name,
         pg_get_indexdef(i.oid) AS definition,
         ix.indisunique AS unique, ix.indisprimary AS primary, ix.indisvalid AS valid,
         -- Primary-key column names in key order (indkey is an int2vector of attnums).
         CASE WHEN ix.indisprimary THEN (
           SELECT array_agg(a.attname::text ORDER BY k.ord)  -- ::text so pg returns a JS string[]
           FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
         ) END AS pk_columns
  FROM pg_index ix
  JOIN pg_class i ON i.oid = ix.indexrelid
  JOIN pg_class t ON t.oid = ix.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE t.relkind IN ('r', 'p') AND NOT t.relispartition
    AND n.nspname = ANY($1::text[])`;

const CONSTRAINTS_SQL = `
  SELECT n.nspname AS schema, c.relname AS table_name, con.conname AS name,
         con.contype AS type,
         pg_get_constraintdef(con.oid) AS definition,
         con.convalidated AS validated
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE con.contype IN ('p', 'f', 'c', 'u', 'x')
    AND c.relkind IN ('r', 'p') AND NOT c.relispartition
    AND n.nspname = ANY($1::text[])`;

// pg_sequences also lists identity/serial sequences; we compare their settings,
// never last_value (that's data, and it differs legitimately between databases).
const SEQUENCES_SQL = `
  SELECT schemaname AS schema, sequencename AS name, data_type::text AS data_type,
         increment_by::text AS increment, min_value::text AS min_value,
         max_value::text AS max_value, cycle
  FROM pg_sequences
  WHERE schemaname = ANY($1::text[])`;

// Objects an extension created (pgcrypto's functions, PostGIS types, ...) belong to the
// extension, which is compared as a whole; listing them one by one would be noise.
const NOT_FROM_EXTENSION = (catalog: string, oid: string) => `
    NOT EXISTS (SELECT 1 FROM pg_depend d
                WHERE d.classid = '${catalog}'::regclass AND d.objid = ${oid} AND d.deptype = 'e')`;

const VIEWS_SQL = `
  SELECT n.nspname AS schema, c.relname AS name, c.relkind = 'm' AS materialized,
         pg_get_viewdef(c.oid, true) AS definition
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('v', 'm')
    AND n.nspname = ANY($1::text[])
    AND ${NOT_FROM_EXTENSION("pg_class", "c.oid")}`;

// prokind: f = function, p = procedure (aggregates and window functions are left out:
// pg_get_functiondef() can't print them).
const ROUTINES_SQL = `
  SELECT n.nspname AS schema, p.proname AS name,
         pg_get_function_identity_arguments(p.oid) AS args,
         p.prokind AS kind, pg_get_functiondef(p.oid) AS definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prokind IN ('f', 'p')
    AND n.nspname = ANY($1::text[])
    AND ${NOT_FROM_EXTENSION("pg_proc", "p.oid")}`;

// tgisinternal = the triggers Postgres creates for foreign keys; those are compared
// as constraints. Partitions' cloned triggers are reported via the parent.
const TRIGGERS_SQL = `
  SELECT n.nspname AS schema, c.relname AS table_name, t.tgname AS name,
         pg_get_triggerdef(t.oid, true) AS definition, t.tgenabled AS enabled
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE NOT t.tgisinternal
    AND NOT c.relispartition
    AND n.nspname = ANY($1::text[])`;

const ENUMS_SQL = `
  SELECT n.nspname AS schema, t.typname AS name,
         array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
  JOIN pg_enum e ON e.enumtypid = t.oid
  WHERE n.nspname = ANY($1::text[])
    AND ${NOT_FROM_EXTENSION("pg_type", "t.oid")}
  GROUP BY n.nspname, t.typname`;

// Extensions are installed per database, not per schema, so this isn't filtered.
const EXTENSIONS_SQL = `
  SELECT e.extname AS name, e.extversion AS version, n.nspname AS schema
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace`;

// Roles are listed by name (polroles {0} = PUBLIC) and sorted, so the same policy prints
// the same on both servers.
const POLICIES_SQL = `
  SELECT n.nspname AS schema, c.relname AS table_name, p.polname AS name,
         p.polpermissive AS permissive, p.polcmd AS cmd,
         CASE WHEN p.polroles = '{0}' THEN ARRAY['public']
              ELSE ARRAY(SELECT r.rolname::text FROM pg_roles r WHERE r.oid = ANY(p.polroles) ORDER BY 1) END AS roles,
         pg_get_expr(p.polqual, p.polrelid) AS qual,
         pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = ANY($1::text[])`;

const TRIGGER_STATES: Record<string, TriggerState> = { O: "enabled", D: "disabled", R: "replica", A: "always" };
const POLICY_COMMANDS: Record<string, string> = { r: "SELECT", a: "INSERT", w: "UPDATE", d: "DELETE", "*": "ALL" };

const CONSTRAINT_TYPES: Record<string, ConstraintType> = {
  p: "primary_key",
  f: "foreign_key",
  c: "check",
  u: "unique",
  x: "exclusion",
};

const IDENTITY: Record<string, "always" | "by default" | null> = { a: "always", d: "by default", "": null };

/** Reads the structure of the given schemas into a typed, JSON-friendly Schema. */
export async function introspect(db: pg.Pool | pg.PoolClient | pg.Client, schemas: string[] = ["public"]): Promise<Schema> {
  // Sequential on purpose: these are small catalog queries, and `db` may be a single
  // client inside a snapshot transaction, which can only run one query at a time.
  const tables = await db.query(TABLES_SQL, [schemas]);
  const columns = await db.query(COLUMNS_SQL, [schemas]);
  const indexes = await db.query(INDEXES_SQL, [schemas]);
  const constraints = await db.query(CONSTRAINTS_SQL, [schemas]);
  const sequences = await db.query(SEQUENCES_SQL, [schemas]);
  const views = await db.query(VIEWS_SQL, [schemas]);
  const routines = await db.query(ROUTINES_SQL, [schemas]);
  const triggers = await db.query(TRIGGERS_SQL, [schemas]);
  const enums = await db.query(ENUMS_SQL, [schemas]);
  const extensions = await db.query(EXTENSIONS_SQL);
  const policies = await db.query(POLICIES_SQL, [schemas]);

  const result: Schema = { tables: {}, sequences: {}, views: {}, routines: {}, triggers: {}, enums: {}, extensions: {}, policies: {} };

  for (const r of tables.rows) {
    result.tables[tableKey(r.schema, r.name)] = {
      schema: r.schema,
      name: r.name,
      columns: {},
      primaryKey: null,
      indexes: {},
      constraints: {},
      estimatedRows: r.estimated_rows,
      totalBytes: r.total_bytes,
      rowSecurity: { enabled: r.row_security, forced: r.force_row_security },
    };
  }

  // Child rows reference their table by schema + name; look it up once.
  const tableOf = (r: { schema: string; table_name: string }): Table | undefined =>
    result.tables[tableKey(r.schema, r.table_name)];

  for (const r of columns.rows) {
    const table = tableOf(r);
    if (!table) continue;
    table.columns[r.name] = {
      name: r.name,
      type: r.type,
      nullable: r.nullable,
      default: r.default_expr,
      identity: IDENTITY[r.identity] ?? null,
      position: r.position,
    };
  }

  for (const r of indexes.rows) {
    const table = tableOf(r);
    if (!table) continue;
    table.indexes[r.name] = {
      name: r.name,
      definition: r.definition,
      unique: r.unique,
      primary: r.primary,
      valid: r.valid,
    };
    if (r.primary) table.primaryKey = r.pk_columns;
  }

  for (const r of constraints.rows) {
    const table = tableOf(r);
    if (!table) continue;
    const constraint: Constraint = {
      name: r.name,
      type: CONSTRAINT_TYPES[r.type]!,
      definition: r.definition,
      validated: r.validated,
    };
    table.constraints[r.name] = constraint;
  }

  for (const r of sequences.rows) {
    result.sequences[tableKey(r.schema, r.name)] = {
      schema: r.schema,
      name: r.name,
      dataType: r.data_type,
      increment: r.increment,
      minValue: r.min_value,
      maxValue: r.max_value,
      cycle: r.cycle,
    };
  }

  for (const r of views.rows) {
    result.views![tableKey(r.schema, r.name)] = { schema: r.schema, name: r.name, materialized: r.materialized, definition: r.definition };
  }
  for (const r of routines.rows) {
    result.routines![`${tableKey(r.schema, r.name)}(${r.args})`] = {
      schema: r.schema,
      name: r.name,
      args: r.args,
      kind: r.kind === "p" ? "procedure" : "function",
      definition: String(r.definition).trimEnd(),
    };
  }
  for (const r of triggers.rows) {
    const table = tableKey(r.schema, r.table_name);
    result.triggers![`${table}.${r.name}`] = { table, name: r.name, definition: r.definition, state: TRIGGER_STATES[r.enabled] ?? "enabled" };
  }
  for (const r of enums.rows) {
    result.enums![tableKey(r.schema, r.name)] = { schema: r.schema, name: r.name, labels: r.labels };
  }
  for (const r of extensions.rows) {
    result.extensions![r.name] = { name: r.name, version: r.version, schema: r.schema };
  }
  for (const r of policies.rows) {
    const table = tableKey(r.schema, r.table_name);
    result.policies![`${table}.${r.name}`] = { table, name: r.name, definition: policyDefinition(table, r), roles: r.roles };
  }

  return result;
}

/** pg_policy row -> a canonical CREATE POLICY statement (also what the planner runs). */
function policyDefinition(table: string, r: { name: string; permissive: boolean; cmd: string; roles: string[]; qual: string | null; with_check: string | null }): string {
  const roles = r.roles.map((role) => (role === "public" ? "PUBLIC" : ident(role))).join(", ");
  return [
    `CREATE POLICY ${ident(r.name)} ON ${tableRef(table)}`,
    `AS ${r.permissive ? "PERMISSIVE" : "RESTRICTIVE"}`,
    `FOR ${POLICY_COMMANDS[r.cmd] ?? "ALL"}`,
    `TO ${roles}`,
    ...(r.qual !== null ? [`USING (${r.qual})`] : []),
    ...(r.with_check !== null ? [`WITH CHECK (${r.with_check})`] : []),
  ].join(" ");
}
