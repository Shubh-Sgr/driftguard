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

export interface Schema {
  /** Keyed by "schema.table". */
  tables: Record<string, Table>;
  /** Keyed by "schema.sequence". */
  sequences: Record<string, Sequence>;
}

export const tableKey = (schema: string, name: string) => `${schema}.${name}`;
