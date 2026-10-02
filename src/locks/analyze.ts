import type { Schema } from "../introspect/types.js";
import { parseSql, rangeVarName, stringList, type AstNode, type ParsedStatement } from "../sql/parse.js";
import { callsVolatileFunction, formatTypeName, isBinaryCompatibleChange, SERIAL_TYPES } from "../sql/types.js";
import { blocksReads, blocksWrites, strongest, type LockMode } from "./modes.js";
import { maxRisk, scoreRisk, type Risk } from "./risk.js";

export interface TableLock {
  table: string;
  mode: LockMode;
}

export interface StatementAnalysis {
  index: number;
  sql: string;
  /** Short label, e.g. "ALTER TABLE ... ADD COLUMN". */
  operation: string;
  locks: TableLock[];
  /** Strongest lock the statement takes, or null if it locks no table. */
  lockMode: LockMode | null;
  blocksReads: boolean;
  blocksWrites: boolean;
  rewritesTable: boolean;
  scansTable: boolean;
  dataLoss: boolean;
  /** False for CONCURRENTLY / VACUUM: Postgres refuses to run them inside BEGIN...COMMIT. */
  transactional: boolean;
  estimatedRows: number | null;
  risk: Risk;
  reasons: string[];
  notes: string[];
}

export interface MigrationAnalysis {
  statements: StatementAnalysis[];
  /** Problems with the script as a whole (ordering, transactions, timeouts). */
  warnings: string[];
  maxRisk: Risk;
}

/** What one statement does, before risk scoring. */
interface Effect {
  operation: string;
  locks: TableLock[];
  rewrites: boolean;
  scans: boolean;
  dataLoss: boolean;
  transactional: boolean;
  notes: string[];
}

const effect = (operation: string, partial: Partial<Effect> = {}): Effect => ({
  operation,
  locks: [],
  rewrites: false,
  scans: false,
  dataLoss: false,
  transactional: true,
  notes: [],
  ...partial,
});

/**
 * F5: predicts, per statement, which lock it takes, what that lock blocks, whether it
 * scans or rewrites the table, and a risk level using table size from `schema`
 * (introspected from the database the migration will run on; optional).
 */
export async function analyzeMigration(sql: string, schema?: Schema): Promise<MigrationAnalysis> {
  return analyzeParsed(await parseSql(sql), schema);
}

export function analyzeParsed(statements: ParsedStatement[], schema?: Schema): MigrationAnalysis {
  const warnings: string[] = [];
  const results: StatementAnalysis[] = [];
  let lockTimeoutSet = false;
  // "table.column" pairs proven NOT NULL by a validated CHECK earlier in THIS script,
  // so a later SET NOT NULL is known to skip its scan (the F6 rewrite relies on this).
  const notNullChecks = new NotNullCheckTracker();
  let inTransaction = false;
  let exclusiveInTransaction = 0;

  for (const stmt of statements) {
    // Track script state that changes how risky later statements are.
    if (stmt.type === "VariableSetStmt" && stmt.node.name === "lock_timeout") {
      lockTimeoutSet = !isZeroSetting(stmt.node);
    }
    if (stmt.type === "TransactionStmt") {
      const kind: string = stmt.node.kind;
      if (kind === "TRANS_STMT_BEGIN" || kind === "TRANS_STMT_START") {
        inTransaction = true;
        exclusiveInTransaction = 0;
      } else if (["TRANS_STMT_COMMIT", "TRANS_STMT_ROLLBACK"].includes(kind)) {
        inTransaction = false;
      }
    }

    const e = effectOf(stmt, schema, notNullChecks);
    notNullChecks.observe(stmt);
    const mode = e.locks.length ? strongest(e.locks.map((l) => l.mode)) : null;
    // Size of the table being changed (the first lock is always the target table).
    const mainTable = e.locks[0]?.table;
    const estimatedRows = mainTable && schema?.tables[mainTable] ? schema.tables[mainTable].estimatedRows : null;
    const { risk, reasons } = scoreRisk({
      blocksReads: mode ? blocksReads(mode) : false,
      blocksWrites: mode ? blocksWrites(mode) : false,
      heavy: e.rewrites || e.scans,
      dataLoss: e.dataLoss,
      estimatedRows,
      lockTimeoutSet,
    });

    if (!e.transactional && inTransaction) {
      warnings.push(`Statement ${stmt.index + 1} (${e.operation}) cannot run inside a transaction block; it will fail between BEGIN and COMMIT.`);
    }
    if (mode === "ACCESS EXCLUSIVE" && inTransaction && ++exclusiveInTransaction === 2) {
      warnings.push("Several ACCESS EXCLUSIVE statements share one transaction: every lock is held until COMMIT, so the blocking window is their combined duration.");
    }

    results.push({
      index: stmt.index,
      sql: stmt.text,
      operation: e.operation,
      locks: e.locks,
      lockMode: mode,
      blocksReads: mode ? blocksReads(mode) : false,
      blocksWrites: mode ? blocksWrites(mode) : false,
      rewritesTable: e.rewrites,
      scansTable: e.scans,
      dataLoss: e.dataLoss,
      transactional: e.transactional,
      estimatedRows,
      risk,
      reasons,
      notes: e.notes,
    });
  }

  const needsLockTimeout = results.some((r) => r.blocksReads || r.blocksWrites);
  const firstSet = statements.findIndex((s) => s.type === "VariableSetStmt" && s.node.name === "lock_timeout");
  const firstBlocking = results.findIndex((r) => r.blocksReads || r.blocksWrites);
  if (needsLockTimeout && (firstSet === -1 || firstSet > firstBlocking)) {
    warnings.push("No SET lock_timeout before the first blocking statement. Add e.g. SET lock_timeout = '3s' and retry on timeout.");
  }

  return { statements: results, warnings, maxRisk: maxRisk(results.map((r) => r.risk)) };
}

/** Maps one parsed statement to its effect. This is the lock rule table. */
function effectOf(stmt: ParsedStatement, schema: Schema | undefined, checks: NotNullCheckTracker): Effect {
  const n = stmt.node;
  switch (stmt.type) {
    case "SelectStmt":
      return effect("SELECT", { locks: collectRangeVars(n).map((t) => ({ table: t, mode: "ACCESS SHARE" })) });

    case "InsertStmt":
    case "UpdateStmt":
    case "DeleteStmt": {
      const op = stmt.type.replace("Stmt", "").toUpperCase();
      const noWhere = stmt.type !== "InsertStmt" && !n.whereClause;
      return effect(op, {
        locks: [{ table: rangeVarName(n.relation), mode: "ROW EXCLUSIVE" }],
        // Row locks, not a table lock, but a WHERE-less UPDATE/DELETE touches every row in
        // one long transaction (row locks on all rows, WAL spike, replication lag).
        scans: noWhere,
        dataLoss: stmt.type === "DeleteStmt",
        notes: noWhere ? [`${op} without WHERE touches every row in one transaction; batch it by primary-key range.`] : [],
      });
    }

    case "IndexStmt":
      return n.concurrent
        ? effect("CREATE INDEX CONCURRENTLY", {
            locks: [{ table: rangeVarName(n.relation), mode: "SHARE UPDATE EXCLUSIVE" }],
            scans: true,
            transactional: false,
            notes: ["If it fails it leaves an INVALID index: DROP INDEX CONCURRENTLY it and retry."],
          })
        : effect("CREATE INDEX", {
            locks: [{ table: rangeVarName(n.relation), mode: "SHARE" }],
            scans: true,
            notes: ["Reads continue, but INSERT/UPDATE/DELETE wait until the whole index is built."],
          });

    case "AlterTableStmt":
      return alterTableEffect(stmt, schema, checks);

    case "RenameStmt": {
      const table = rangeVarName(n.relation);
      const what = n.renameType === "OBJECT_COLUMN" ? "RENAME COLUMN" : n.renameType === "OBJECT_TABLE" ? "RENAME TABLE" : `RENAME ${String(n.renameType).replace("OBJECT_", "")}`;
      return effect(`ALTER TABLE ... ${what}`, {
        locks: [{ table, mode: "ACCESS EXCLUSIVE" }],
        notes: ["Instant, but running application code that uses the old name breaks immediately."],
      });
    }

    case "DropStmt":
      return dropEffect(n, schema);

    case "TruncateStmt":
      return effect("TRUNCATE", {
        locks: (n.relations ?? []).map((r: AstNode) => ({ table: rangeVarName(r.RangeVar), mode: "ACCESS EXCLUSIVE" as LockMode })),
        dataLoss: true,
      });

    case "VacuumStmt": {
      const opts: string[] = (n.options ?? []).map((o: AstNode) => o.DefElem.defname);
      const tables = (n.rels ?? []).map((r: AstNode) => rangeVarName(r.VacuumRelation.relation));
      if (opts.includes("full")) {
        return effect("VACUUM FULL", {
          locks: tables.map((t: string) => ({ table: t, mode: "ACCESS EXCLUSIVE" as LockMode })),
          rewrites: true,
          transactional: false,
          notes: ["Rewrites the whole table. Consider pg_repack, which holds the exclusive lock only briefly."],
        });
      }
      return effect(n.is_vacuumcmd ? "VACUUM" : "ANALYZE", {
        locks: tables.map((t: string) => ({ table: t, mode: "SHARE UPDATE EXCLUSIVE" as LockMode })),
        transactional: !n.is_vacuumcmd, // ANALYZE may run in a transaction; VACUUM may not
      });
    }

    case "ClusterStmt":
      return effect("CLUSTER", {
        locks: n.relation ? [{ table: rangeVarName(n.relation), mode: "ACCESS EXCLUSIVE" }] : [],
        rewrites: true,
        notes: ["Rewrites the whole table. Consider pg_repack instead."],
      });

    case "ReindexStmt": {
      const concurrent = (n.params ?? []).some((p: AstNode) => p.DefElem?.defname === "concurrently");
      const target = n.relation ? rangeVarName(n.relation) : "(database)";
      return concurrent
        ? effect("REINDEX CONCURRENTLY", { locks: [{ table: target, mode: "SHARE UPDATE EXCLUSIVE" }], scans: true, transactional: false })
        : effect("REINDEX", {
            // REINDEX INDEX locks the parent table in SHARE mode (blocks writes).
            locks: [{ table: target, mode: "SHARE" }],
            scans: true,
            notes: ["Blocks writes while rebuilding; use REINDEX ... CONCURRENTLY (PG 12+)."],
          });
    }

    case "CreateStmt": {
      // A new table has no traffic. Only its foreign keys lock the referenced tables.
      const referenced = collectForeignKeyTargets(n);
      return effect("CREATE TABLE", {
        locks: referenced.map((t) => ({ table: t, mode: "SHARE ROW EXCLUSIVE" as LockMode })),
        notes: referenced.length ? ["Foreign keys briefly lock the referenced tables against writes (no scan: the new table is empty)."] : [],
      });
    }

    case "VariableSetStmt":
      return effect(`SET ${n.name ?? ""}`.trim());
    case "TransactionStmt":
      return effect(String(n.kind).replace("TRANS_STMT_", ""));
    case "CreateSeqStmt":
      return effect("CREATE SEQUENCE");
    case "AlterSeqStmt":
      return effect("ALTER SEQUENCE");
    case "CommentStmt":
      return effect("COMMENT");

    case "CreateTrigStmt":
      // Blocks writes while the trigger is added (no scan): reads continue.
      return effect(n.replace ? "CREATE OR REPLACE TRIGGER" : "CREATE TRIGGER", {
        locks: [{ table: rangeVarName(n.relation), mode: "SHARE ROW EXCLUSIVE" }],
      });
    case "CreatePolicyStmt":
    case "AlterPolicyStmt":
      return effect(stmt.type === "CreatePolicyStmt" ? "CREATE POLICY" : "ALTER POLICY", {
        locks: [{ table: rangeVarName(n.table), mode: "ACCESS EXCLUSIVE" }],
        notes: ["Metadata-only, but it changes which rows each role can see or write."],
      });
    case "ViewStmt":
      // A new view has no traffic; replacing one locks the view (not its tables).
      return effect(n.replace ? "CREATE OR REPLACE VIEW" : "CREATE VIEW", {
        locks: n.replace ? [{ table: rangeVarName(n.view), mode: "ACCESS EXCLUSIVE" }] : [],
      });
    case "CreateTableAsStmt":
      return effect(n.objtype === "OBJECT_MATVIEW" ? "CREATE MATERIALIZED VIEW" : "CREATE TABLE AS", {
        notes: ["Runs its query once to fill the new relation: only read locks on the source tables, but it can take long."],
      });
    case "CreateFunctionStmt":
      return effect(n.is_procedure ? "CREATE PROCEDURE" : "CREATE FUNCTION");
    case "CreateEnumStmt":
      return effect("CREATE TYPE");
    case "AlterEnumStmt":
      return effect("ALTER TYPE ... ADD VALUE", { notes: ["A new label can't be used in the same transaction that adds it."] });
    case "CreateExtensionStmt":
    case "AlterExtensionStmt":
      return effect(stmt.type === "CreateExtensionStmt" ? "CREATE EXTENSION" : "ALTER EXTENSION", {
        notes: ["Usually needs a privileged role; an extension's install or upgrade script can take its own locks."],
      });
    default:
      return effect(stmt.type, {
        // Unknown to our rule table: say so instead of pretending it's safe.
        notes: [`${stmt.type} is not in PgVouch's lock rule table; review its locking manually.`],
      });
  }
}

function alterTableEffect(stmt: ParsedStatement, schema: Schema | undefined, checks: NotNullCheckTracker): Effect {
  const n = stmt.node;
  const table = rangeVarName(n.relation);
  const parts: Effect[] = (n.cmds ?? []).map((c: AstNode) => alterCmdEffect(table, c.AlterTableCmd, schema, checks));

  if (parts.length === 1) return parts[0]!;
  // Several sub-commands in one ALTER: one lock (the strongest), all effects combined.
  return effect(`ALTER TABLE (${parts.map((p) => p.operation.replace("ALTER TABLE ... ", "")).join(", ")})`, {
    locks: mergeLocks(parts.flatMap((p) => p.locks)),
    rewrites: parts.some((p) => p.rewrites),
    scans: parts.some((p) => p.scans),
    dataLoss: parts.some((p) => p.dataLoss),
    notes: parts.flatMap((p) => p.notes),
  });
}

function alterCmdEffect(table: string, cmd: AstNode, schema: Schema | undefined, checks: NotNullCheckTracker): Effect {
  const accessExclusive = [{ table, mode: "ACCESS EXCLUSIVE" as LockMode }];
  const op = (s: string) => `ALTER TABLE ... ${s}`;

  switch (cmd.subtype) {
    case "AT_AddColumn": {
      const col = cmd.def.ColumnDef;
      const constraints: AstNode[] = (col.constraints ?? []).map((c: AstNode) => c.Constraint);
      const def = constraints.find((c) => c.contype === "CONSTR_DEFAULT");
      const notNull = constraints.some((c) => c.contype === "CONSTR_NOTNULL");
      const typeName = formatTypeName(col.typeName);
      const serial = SERIAL_TYPES.has(typeName);
      const generatedStored = constraints.some((c) => c.contype === "CONSTR_GENERATED");
      const identity = constraints.some((c) => c.contype === "CONSTR_IDENTITY");
      const volatileDefault = def ? callsVolatileFunction(def.raw_expr) : false;
      const inlineCheckOrFk = constraints.some((c) => c.contype === "CONSTR_CHECK" || c.contype === "CONSTR_FOREIGN");
      const rewrites = volatileDefault || serial || generatedStored || identity;
      const notes: string[] = [];
      if (rewrites) notes.push("Every existing row needs its own computed value, so the whole table is rewritten.");
      else if (def) notes.push("Constant default: since PG 11 this is metadata-only (no rewrite).");
      if (notNull && !def && !identity && !serial) notes.push("NOT NULL without a DEFAULT fails if the table already has rows.");
      if (inlineCheckOrFk) notes.push("The inline CHECK/REFERENCES constraint is validated against every existing row.");
      return effect(op("ADD COLUMN"), { locks: accessExclusive, rewrites, scans: inlineCheckOrFk, notes });
    }

    case "AT_DropColumn":
      return effect(op("DROP COLUMN"), {
        locks: accessExclusive,
        dataLoss: true,
        notes: ["Metadata-only (the space is reclaimed later), but the column's data is gone."],
      });

    case "AT_AlterColumnType": {
      const newType = formatTypeName(cmd.def.ColumnDef.typeName);
      const oldType = schema?.tables[table]?.columns[cmd.name]?.type;
      const binaryCompatible = oldType !== undefined && !cmd.def.ColumnDef.raw_default && isBinaryCompatibleChange(oldType, newType);
      return effect(op("ALTER COLUMN TYPE"), {
        locks: accessExclusive,
        rewrites: !binaryCompatible,
        notes: binaryCompatible
          ? [`${oldType} -> ${newType} is binary compatible: catalog-only change, no rewrite.`]
          : [oldType ? `${oldType} -> ${newType} rewrites the table and rebuilds its indexes.` : `Assumed to rewrite the table (current type unknown without a database connection).`],
      });
    }

    case "AT_SetNotNull": {
      // PG 12+: if a VALIDATED CHECK (col IS NOT NULL) already exists, the scan is skipped.
      const hasCheck =
        checks.isProven(table, cmd.name) ||
        Object.values(schema?.tables[table]?.constraints ?? {}).some(
          (c) => c.type === "check" && c.validated && isNotNullCheck(c.definition, cmd.name),
        );
      return effect(op("SET NOT NULL"), {
        locks: accessExclusive,
        scans: !hasCheck,
        notes: hasCheck ? ["A validated CHECK (col IS NOT NULL) exists, so Postgres skips the full-table scan."] : ["Scans the whole table under ACCESS EXCLUSIVE to prove there are no NULLs."],
      });
    }

    case "AT_DropNotNull":
      return effect(op("DROP NOT NULL"), { locks: accessExclusive });
    case "AT_ColumnDefault":
      return effect(op(cmd.def ? "SET DEFAULT" : "DROP DEFAULT"), { locks: accessExclusive, notes: ["Affects only future rows; metadata-only."] });

    case "AT_AddConstraint":
      return addConstraintEffect(table, cmd.def.Constraint, op);

    case "AT_ValidateConstraint":
      return effect(op("VALIDATE CONSTRAINT"), {
        locks: [{ table, mode: "SHARE UPDATE EXCLUSIVE" }],
        scans: true,
        notes: ["Scans the table but does not block reads or writes: the safe second step after NOT VALID."],
      });

    case "AT_DropConstraint":
      return effect(op("DROP CONSTRAINT"), { locks: accessExclusive });

    case "AT_EnableTrig":
    case "AT_EnableAlwaysTrig":
    case "AT_EnableReplicaTrig":
    case "AT_DisableTrig":
    case "AT_EnableTrigAll":
    case "AT_DisableTrigAll":
    case "AT_EnableTrigUser":
    case "AT_DisableTrigUser":
      // ENABLE / DISABLE TRIGGER takes SHARE ROW EXCLUSIVE (docs): blocks writes, not reads.
      return effect(op(cmd.subtype.startsWith("AT_Disable") ? "DISABLE TRIGGER" : "ENABLE TRIGGER"), {
        locks: [{ table, mode: "SHARE ROW EXCLUSIVE" }],
        notes: cmd.subtype.startsWith("AT_Disable") ? ["A disabled trigger silently skips its logic for every write until it is enabled again."] : [],
      });

    case "AT_EnableRowSecurity":
    case "AT_DisableRowSecurity":
    case "AT_ForceRowSecurity":
    case "AT_NoForceRowSecurity":
      return effect(op(cmd.subtype.replace("AT_", "").replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase()), {
        locks: accessExclusive,
        notes: ["Metadata-only, but it changes which rows non-owner roles can see."],
      });

    case "AT_SetStatistics":
    case "AT_SetOptions":
    case "AT_ResetOptions":
    case "AT_SetRelOptions":
    case "AT_ResetRelOptions":
      return effect(op(cmd.subtype.replace("AT_", "").toUpperCase()), { locks: [{ table, mode: "SHARE UPDATE EXCLUSIVE" }] });

    default:
      return effect(op(String(cmd.subtype).replace("AT_", "")), {
        locks: accessExclusive,
        notes: [`${cmd.subtype} is not in the rule table; assuming the worst case (ACCESS EXCLUSIVE).`],
      });
  }
}

function addConstraintEffect(table: string, c: AstNode, op: (s: string) => string): Effect {
  const notValid = !!c.skip_validation;
  switch (c.contype) {
    case "CONSTR_FOREIGN": {
      // SHARE ROW EXCLUSIVE on BOTH tables: writes to either wait.
      const referenced = rangeVarName(c.pktable);
      return effect(op(notValid ? "ADD FOREIGN KEY NOT VALID" : "ADD FOREIGN KEY"), {
        locks: mergeLocks([
          { table, mode: "SHARE ROW EXCLUSIVE" },
          { table: referenced, mode: "SHARE ROW EXCLUSIVE" },
        ]),
        scans: !notValid,
        notes: notValid ? ["NOT VALID: only new rows are checked; run VALIDATE CONSTRAINT next."] : ["Checks every existing row while holding the lock."],
      });
    }
    case "CONSTR_CHECK":
      return effect(op(notValid ? "ADD CHECK NOT VALID" : "ADD CHECK"), {
        locks: [{ table, mode: "ACCESS EXCLUSIVE" }],
        scans: !notValid,
        notes: notValid ? ["NOT VALID: only new rows are checked; run VALIDATE CONSTRAINT next."] : ["Checks every existing row under ACCESS EXCLUSIVE (blocks reads too)."],
      });
    case "CONSTR_UNIQUE":
    case "CONSTR_PRIMARY": {
      const kind = c.contype === "CONSTR_UNIQUE" ? "UNIQUE" : "PRIMARY KEY";
      if (c.indexname) {
        return effect(op(`ADD ${kind} USING INDEX`), {
          locks: [{ table, mode: "ACCESS EXCLUSIVE" }],
          notes: ["Reuses an existing index: metadata-only."],
        });
      }
      return effect(op(`ADD ${kind}`), {
        locks: [{ table, mode: "ACCESS EXCLUSIVE" }],
        scans: true,
        notes: ["Builds a unique index under ACCESS EXCLUSIVE. Build it CONCURRENTLY first, then ADD ... USING INDEX."],
      });
    }
    default:
      return effect(op(`ADD CONSTRAINT (${String(c.contype).replace("CONSTR_", "")})`), {
        locks: [{ table, mode: "ACCESS EXCLUSIVE" }],
        scans: true,
      });
  }
}

function dropEffect(n: AstNode, schema?: Schema): Effect {
  const names: string[] = (n.objects ?? []).map((o: AstNode) => stringList(o.List?.items).join("."));
  const qualify = (name: string) => (name.includes(".") ? name : `public.${name}`);

  if (n.removeType === "OBJECT_TABLE") {
    return effect("DROP TABLE", {
      locks: names.map((t) => ({ table: qualify(t), mode: "ACCESS EXCLUSIVE" as LockMode })),
      dataLoss: true,
    });
  }
  if (n.removeType === "OBJECT_INDEX") {
    // DROP INDEX locks the index's TABLE; find it via the schema if we have one.
    const tables = names.map((idx) => findIndexTable(idx, schema) ?? `(table of index ${idx})`);
    return n.concurrent
      ? effect("DROP INDEX CONCURRENTLY", { locks: tables.map((t) => ({ table: t, mode: "SHARE UPDATE EXCLUSIVE" as LockMode })), transactional: false })
      : effect("DROP INDEX", {
          locks: tables.map((t) => ({ table: t, mode: "ACCESS EXCLUSIVE" as LockMode })),
          notes: ["Use DROP INDEX CONCURRENTLY to avoid blocking the table."],
        });
  }
  if (n.removeType === "OBJECT_TRIGGER" || n.removeType === "OBJECT_POLICY") {
    // "table.trigger" / "schema.table.policy": the lock is on the table.
    const tables = (n.objects ?? []).map((o: AstNode) => qualify(stringList(o.List?.items).slice(0, -1).join(".")));
    return effect(n.removeType === "OBJECT_TRIGGER" ? "DROP TRIGGER" : "DROP POLICY", {
      locks: tables.map((t: string) => ({ table: t, mode: "ACCESS EXCLUSIVE" as LockMode })),
    });
  }
  if (n.removeType === "OBJECT_VIEW" || n.removeType === "OBJECT_MATVIEW") {
    return effect(n.removeType === "OBJECT_VIEW" ? "DROP VIEW" : "DROP MATERIALIZED VIEW", {
      locks: names.map((v) => ({ table: qualify(v), mode: "ACCESS EXCLUSIVE" as LockMode })),
    });
  }
  if (["OBJECT_FUNCTION", "OBJECT_PROCEDURE", "OBJECT_ROUTINE", "OBJECT_TYPE"].includes(n.removeType)) {
    return effect(`DROP ${String(n.removeType).replace("OBJECT_", "")}`, {
      notes: ["Takes no table lock, but fails (or, with CASCADE, drops more) if other objects depend on it."],
    });
  }
  return effect(`DROP ${String(n.removeType).replace("OBJECT_", "")}`, {
    notes: ["Not in the lock rule table; review manually."],
  });
}

function findIndexTable(index: string, schema?: Schema): string | undefined {
  const bare = index.split(".").at(-1)!;
  return Object.entries(schema?.tables ?? {}).find(([, t]) => t.indexes[bare])?.[0];
}

/** Keeps one entry per table, with the strongest mode. */
function mergeLocks(locks: TableLock[]): TableLock[] {
  const byTable = new Map<string, LockMode>();
  for (const l of locks) byTable.set(l.table, strongest([byTable.get(l.table) ?? "ACCESS SHARE", l.mode]));
  return [...byTable].map(([table, mode]) => ({ table, mode }));
}

/** All table references in a SELECT (FROM clauses, joins, subqueries). */
function collectRangeVars(node: AstNode, out: string[] = []): string[] {
  if (node && typeof node === "object") {
    if (node.RangeVar) out.push(rangeVarName(node.RangeVar));
    for (const v of Object.values(node)) collectRangeVars(v, out);
  }
  return [...new Set(out)];
}

function collectForeignKeyTargets(node: AstNode, out: string[] = []): string[] {
  if (node && typeof node === "object") {
    if (node.contype === "CONSTR_FOREIGN" && node.pktable) out.push(rangeVarName(node.pktable));
    for (const v of Object.values(node)) collectForeignKeyTargets(v, out);
  }
  return [...new Set(out)];
}

/**
 * Follows CHECK (col IS NOT NULL) constraints through a script: added NOT VALID, then
 * VALIDATEd (or added valid straight away). Once validated, the column is proven NOT NULL.
 */
class NotNullCheckTracker {
  private pending = new Map<string, string>(); // "table.constraint" -> column
  private proven = new Set<string>(); // "table.column"

  isProven(table: string, column: string): boolean {
    return this.proven.has(`${table}.${column}`);
  }

  observe(stmt: ParsedStatement): void {
    if (stmt.type !== "AlterTableStmt") return;
    const table = rangeVarName(stmt.node.relation);
    for (const { AlterTableCmd: cmd } of stmt.node.cmds ?? []) {
      if (cmd.subtype === "AT_AddConstraint") {
        const c = cmd.def.Constraint;
        const test = c.contype === "CONSTR_CHECK" ? c.raw_expr?.NullTest : undefined;
        const column = test?.nulltesttype === "IS_NOT_NULL" ? test.arg?.ColumnRef?.fields?.[0]?.String?.sval : undefined;
        if (!column) continue;
        if (c.skip_validation) this.pending.set(`${table}.${c.conname}`, column);
        else this.proven.add(`${table}.${column}`);
      } else if (cmd.subtype === "AT_ValidateConstraint") {
        const column = this.pending.get(`${table}.${cmd.name}`);
        if (column) this.proven.add(`${table}.${column}`);
      }
    }
  }
}

/** Matches pg_get_constraintdef() output for CHECK (col IS NOT NULL), e.g. CHECK ((col IS NOT NULL)). */
function isNotNullCheck(definition: string, column: string): boolean {
  const normalized = definition.replace(/[()"]/g, "").replace(/\s+/g, " ").trim();
  return normalized === `CHECK ${column} IS NOT NULL`;
}

/** SET lock_timeout = 0 (or '0') disables it. */
function isZeroSetting(node: AstNode): boolean {
  const arg = node.args?.[0]?.A_Const;
  if (!arg) return node.kind !== "VAR_SET_VALUE"; // RESET / SET DEFAULT
  if (arg.ival !== undefined) return (arg.ival.ival ?? 0) === 0;
  return /^0\s*(ms|s|min)?$/.test(arg.sval?.sval ?? "");
}
