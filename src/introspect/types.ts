// The typed schema model every other feature works with.
// Objects are keyed by name in plain records (not Maps) so a Schema is plain JSON:
// it can be printed, stored in a receipt, or sent over MCP without conversion.

export interface Column {
  name: string;
  /** Exact type from format_type(), e.g. "numeric(12,2)", "character varying(50)". */
  type: string;
  nullable: boolean;
  /** Default expression as Postgres prints it, or null. */
  default: string | null;
  identity: "always" | "by default" | null;
  /** 1-based position; kept for display, never compared (column order isn't drift). */
  position: number;
}

export interface Index {
  name: string;
  /** Canonical CREATE INDEX statement from pg_get_indexdef(). */
  definition: string;
  unique: boolean;
  primary: boolean;
  /** False if a CREATE INDEX CONCURRENTLY failed halfway and left it INVALID. */
  valid: boolean;
}

export type ConstraintType = "primary_key" | "foreign_key" | "check" | "unique" | "exclusion";

export interface Constraint {
  name: string;
  type: ConstraintType;
  /** Canonical definition from pg_get_constraintdef(), includes "NOT VALID" if unvalidated. */
  definition: string;
  validated: boolean;
}

export interface Table {
  schema: string;
  name: string;
  columns: Record<string, Column>;
  /** Primary-key column names in key order, or null if the table has no PK. */
  primaryKey: string[] | null;
  indexes: Record<string, Index>;
  constraints: Record<string, Constraint>;
  /** pg_class.reltuples — a planner ESTIMATE, -1 if never analyzed. */
  estimatedRows: number;
  /** pg_total_relation_size(): table + indexes + TOAST, in bytes. */
  totalBytes: number;
  /** Row-level security (ALTER TABLE ... ENABLE / FORCE ROW LEVEL SECURITY). */
  rowSecurity?: { enabled: boolean; forced: boolean };
}

export interface Sequence {
  schema: string;
  name: string;
  dataType: string;
  increment: string;
  minValue: string;
  maxValue: string;
  cycle: boolean;
}

/** A view or materialized view; definition from pg_get_viewdef(). */
export interface View {
  schema: string;
  name: string;
  materialized: boolean;
  definition: string;
}

/** A function or procedure; definition is the full CREATE OR REPLACE from pg_get_functiondef(). */
export interface Routine {
  schema: string;
  name: string;
  /** Identity arguments, e.g. "integer, text": part of the key (functions can be overloaded). */
  args: string;
  kind: "function" | "procedure";
  definition: string;
}

export type TriggerState = "enabled" | "disabled" | "replica" | "always";

export interface Trigger {
  /** "schema.table" the trigger is on. */
  table: string;
  name: string;
  /** Canonical CREATE TRIGGER from pg_get_triggerdef(). */
  definition: string;
  /** A disabled trigger silently skips its logic, so the state is compared too. */
  state: TriggerState;
}

export interface EnumType {
  schema: string;
  name: string;
  /** Labels in sort order. */
  labels: string[];
}

export interface Extension {
  name: string;
  version: string;
  schema: string;
}

export interface Policy {
  /** "schema.table" the policy is on. */
  table: string;
  name: string;
  /** A canonical CREATE POLICY statement built from pg_policy. */
  definition: string;
  /** Roles the policy applies to ("public" for PUBLIC). */
  roles?: string[];
}

export interface Schema {
  /** Keyed by "schema.table". */
  tables: Record<string, Table>;
  /** Keyed by "schema.sequence". */
  sequences: Record<string, Sequence>;
  // The rest are optional only so older receipts and hand-built test schemas stay valid;
  // introspect() always fills them in.
  /** Keyed by "schema.view". */
  views?: Record<string, View>;
  /** Keyed by "schema.name(args)". Functions that belong to an extension are left out. */
  routines?: Record<string, Routine>;
  /** Keyed by "schema.table.trigger". Internal (foreign-key) triggers are left out. */
  triggers?: Record<string, Trigger>;
  /** Keyed by "schema.type". */
  enums?: Record<string, EnumType>;
  /** Keyed by extension name. Extensions are database-wide. */
  extensions?: Record<string, Extension>;
  /** Keyed by "schema.table.policy". */
  policies?: Record<string, Policy>;
}

export const tableKey = (schema: string, name: string) => `${schema}.${name}`;
