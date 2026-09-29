import type { Schema } from "../introspect/types.js";
import { analyzeParsed, type StatementAnalysis } from "../locks/analyze.js";
import { constraintName, ident, tableRef } from "../sql/ident.js";
import { parseSql, rangeVarName, sliceBytes, stringList, type AstNode, type ParsedStatement } from "../sql/parse.js";
import { formatTypeName } from "../sql/types.js";

export type RuleId =
  | "create_index_concurrently"
  | "drop_index_concurrently"
  | "reindex_concurrently"
  | "foreign_key_not_valid"
  | "check_not_valid"
  | "unique_using_index"
  | "add_column_expand"
  | "set_not_null_via_check"
  | "alter_type_expand_contract"
  | "rename_column_expand_contract"
  | "batched_write"
  | "table_rewrite_pg_repack";

export interface RewriteStep {
  sql: string;
  /** false = must run outside BEGIN/COMMIT (CONCURRENTLY, or a batch loop that COMMITs). */
  transactional: boolean;
  /** manual = a human action (deploy code, run a tool); its sql is a comment. */
  kind: "ddl" | "backfill" | "manual";
  note?: string;
}

export interface StatementRewrite {
  index: number;
  original: string;
  /** Which rule fired, or null if the statement is already safe / has no automatic rewrite. */
  rule: RuleId | null;
  steps: RewriteStep[];
  explanation: string;
  /** True if a step contains a placeholder or manual action a human must fill in. */
  needsHumanInput: boolean;
  analysis: StatementAnalysis;
}

export interface RewriteResult {
  statements: StatementRewrite[];
  /** The full, commented script, starting with SET lock_timeout / statement_timeout. */
  script: string;
}

export interface RewriteOptions {
  schema?: Schema;
  lockTimeout?: string;
  statementTimeout?: string;
  batchSize?: number;
}

interface Ctx {
  schema?: Schema;
  batchSize: number;
  statementTimeout: string;
}

/**
 * F6: rewrites risky DDL into safe multi-step equivalents (expand/contract).
 * Deterministic rules, not an LLM: these transformations must be right every time.
 */
export async function rewriteMigration(sql: string, opts: RewriteOptions = {}): Promise<RewriteResult> {
  const parsed = await parseSql(sql);
  const analysis = analyzeParsed(parsed, opts.schema);
  const ctx: Ctx = { schema: opts.schema, batchSize: opts.batchSize ?? 10_000, statementTimeout: opts.statementTimeout ?? "30min" };

  const statements: StatementRewrite[] = parsed
    // The script gets its own SET lock_timeout / statement_timeout header, so drop the
    // user's copies of those to avoid conflicting values.
    .filter((s) => !(s.type === "VariableSetStmt" && ["lock_timeout", "statement_timeout"].includes(s.node.name)))
    // Transaction control is re-decided per step (CONCURRENTLY can't run in a transaction).
    .filter((s) => s.type !== "TransactionStmt")
    .map((stmt) => {
      const a = analysis.statements[stmt.index]!;
      const r = applyRules(stmt, a, ctx);
      const steps = r?.steps ?? [{ sql: stmt.text, transactional: a.transactional, kind: "ddl" as const }];
      return {
        index: stmt.index,
        original: stmt.text,
        rule: r?.rule ?? null,
        steps,
        explanation: r?.explanation ?? explainUnchanged(a),
        needsHumanInput: steps.some((s) => s.kind === "manual" || s.sql.includes("/* TODO")),
        analysis: a,
      };
    });

  return { statements, script: renderScript(statements, opts.lockTimeout ?? "3s", ctx.statementTimeout) };
}

type RuleResult = { rule: RuleId; steps: RewriteStep[]; explanation: string } | null;

function applyRules(stmt: ParsedStatement, a: StatementAnalysis, ctx: Ctx): RuleResult {
  const n = stmt.node;
  switch (stmt.type) {
    case "IndexStmt":
      if (n.concurrent) return null;
      return {
        rule: "create_index_concurrently",
        steps: [{
          sql: stmt.text.replace(/^CREATE(\s+UNIQUE)?\s+INDEX\b/i, (m) => `${m} CONCURRENTLY`),
          transactional: false,
          kind: "ddl",
          note: "If this fails it leaves an INVALID index: DROP INDEX CONCURRENTLY it, then retry.",
        }],
        explanation: "CREATE INDEX blocks all writes while it builds. CONCURRENTLY builds without blocking writes (slower, and it cannot run inside a transaction).",
      };

    case "DropStmt": {
      if (n.removeType !== "OBJECT_INDEX" || n.concurrent) return null;
      // DROP INDEX CONCURRENTLY accepts only one index per statement.
      const names: string[] = n.objects.map((o: AstNode) => stringList(o.List.items).map(ident).join("."));
      return {
        rule: "drop_index_concurrently",
        steps: names.map((name) => ({
          sql: `DROP INDEX CONCURRENTLY ${n.missing_ok ? "IF EXISTS " : ""}${name}`,
          transactional: false,
          kind: "ddl" as const,
        })),
        explanation: "DROP INDEX takes ACCESS EXCLUSIVE on the table. CONCURRENTLY waits for running queries instead of blocking new ones.",
      };
    }

    case "ReindexStmt": {
      const concurrent = (n.params ?? []).some((p: AstNode) => p.DefElem?.defname === "concurrently");
      if (concurrent) return null;
      return {
        rule: "reindex_concurrently",
        steps: [{ sql: stmt.text.replace(/^REINDEX\s+(INDEX|TABLE)\b/i, (m) => `${m} CONCURRENTLY`), transactional: false, kind: "ddl" }],
        explanation: "REINDEX blocks writes; REINDEX CONCURRENTLY (PG 12+) does not.",
      };
    }

    case "AlterTableStmt": {
      // Several sub-commands share one lock; we only rewrite single-command ALTERs
      // (explainUnchanged tells the user to split it).
      if (n.cmds.length !== 1) return null;
      return alterTableRule(stmt, n.cmds[0].AlterTableCmd, a, ctx);
    }

    case "RenameStmt":
      if (n.renameType !== "OBJECT_COLUMN") return null;
      return renameColumnRule(rangeVarName(n.relation), n.subname, n.newname, ctx);

    case "UpdateStmt":
    case "DeleteStmt": {
      // Appending a WHERE is only correct for the plain form (no FROM/USING/RETURNING).
      if (n.whereClause || n.fromClause || n.usingClause || n.returningList) return null;
      const batch = batchLoop(rangeVarName(n.relation), stmt.text, false, ctx);
      if (!batch) return null;
      return {
        rule: "batched_write",
        steps: [batch],
        explanation: "A WHERE-less UPDATE/DELETE changes every row in one long transaction (row locks everywhere, a WAL spike, replica lag). Batches of short transactions avoid that.",
      };
    }

    case "VacuumStmt":
    case "ClusterStmt":
      if (!a.rewritesTable) return null;
      return {
        rule: "table_rewrite_pg_repack",
        steps: [{
          sql: `-- MANUAL: use pg_repack instead, e.g.  pg_repack --table=${a.locks[0]?.table ?? "<table>"} <database>`,
          transactional: false,
          kind: "manual",
        }],
        explanation: "VACUUM FULL / CLUSTER hold ACCESS EXCLUSIVE for the whole rewrite. pg_repack rebuilds the table online and takes the exclusive lock only for a brief swap.",
      };

    default:
      return null;
  }
}

function alterTableRule(stmt: ParsedStatement, cmd: AstNode, a: StatementAnalysis, ctx: Ctx): RuleResult {
  const key = rangeVarName(stmt.node.relation);
  const t = tableRef(key);

  switch (cmd.subtype) {
    case "AT_AddConstraint": {
      const c = cmd.def.Constraint;
      if ((c.contype === "CONSTR_FOREIGN" || c.contype === "CONSTR_CHECK") && !c.skip_validation) {
        const isFk = c.contype === "CONSTR_FOREIGN";
        const name: string = c.conname ?? constraintName(key.split(".")[1]!, ...(isFk ? stringList(c.fk_attrs) : []), isFk ? "fkey" : "check");
        // Name it explicitly if the user didn't, so the VALIDATE step can refer to it.
        const text = c.conname ? stmt.text : stmt.text.replace(/\bADD\s+(FOREIGN\s+KEY|CHECK)\b/i, (_m, what) => `ADD CONSTRAINT ${ident(name)} ${what}`);
        return {
          rule: isFk ? "foreign_key_not_valid" : "check_not_valid",
          steps: [
            { sql: `${text} NOT VALID`, transactional: true, kind: "ddl", note: "Instant: only new/updated rows are checked from now on." },
            { sql: `ALTER TABLE ${t} VALIDATE CONSTRAINT ${ident(name)}`, transactional: true, kind: "ddl", note: "Checks existing rows under SHARE UPDATE EXCLUSIVE: reads and writes continue." },
          ],
          explanation: `Adding a ${isFk ? "foreign key" : "CHECK"} constraint validates every existing row while holding a lock that blocks ${isFk ? "writes" : "reads and writes"}. NOT VALID + VALIDATE splits it into an instant step and a non-blocking scan.`,
        };
      }
      if ((c.contype === "CONSTR_UNIQUE" || c.contype === "CONSTR_PRIMARY") && !c.indexname) {
        const primary = c.contype === "CONSTR_PRIMARY";
        const keys = stringList(c.keys);
        const name: string = c.conname ?? constraintName(key.split(".")[1]!, ...(primary ? [] : keys), primary ? "pkey" : "key");
        return {
          rule: "unique_using_index",
          steps: [
            { sql: `CREATE UNIQUE INDEX CONCURRENTLY ${ident(name)} ON ${t} (${keys.map(ident).join(", ")})`, transactional: false, kind: "ddl" },
            {
              sql: `ALTER TABLE ${t} ADD CONSTRAINT ${ident(name)} ${primary ? "PRIMARY KEY" : "UNIQUE"} USING INDEX ${ident(name)}`,
              transactional: true,
              kind: "ddl",
              note: primary ? "Instant if the key columns are already NOT NULL; otherwise it scans (use the SET NOT NULL rewrite first)." : "Instant: reuses the index built above.",
            },
          ],
          explanation: "ADD UNIQUE / PRIMARY KEY builds its index under ACCESS EXCLUSIVE. Building the index CONCURRENTLY first and attaching it with USING INDEX avoids the long lock.",
        };
      }
      return null;
    }

    case "AT_AddColumn":
      return addColumnRule(stmt, cmd.def.ColumnDef, key, a, ctx);

    case "AT_SetNotNull":
      if (!a.scansTable) return null;
      return {
        rule: "set_not_null_via_check",
        steps: setNotNullSteps(key, cmd.name),
        explanation: "SET NOT NULL scans the whole table under ACCESS EXCLUSIVE. Since PG 12 it skips the scan if a validated CHECK (col IS NOT NULL) exists, and that CHECK can be added NOT VALID and validated without blocking.",
      };

    case "AT_AlterColumnType": {
      if (!a.rewritesTable) return null;
      const col: string = cmd.name;
      const newType = formatTypeName(cmd.def.ColumnDef.typeName);
      const tmp = `${col}_new`;
      return {
        rule: "alter_type_expand_contract",
        steps: [
          { sql: `ALTER TABLE ${t} ADD COLUMN ${ident(tmp)} ${newType}`, transactional: true, kind: "ddl", note: "Expand: instant, nullable, no default." },
          { sql: `-- MANUAL: deploy code (or a trigger) that writes ${col} AND ${tmp} on every INSERT/UPDATE`, transactional: true, kind: "manual" },
          backfillOrManual(key, `${ident(tmp)} = ${ident(col)}::${newType}`, `${ident(tmp)} IS NULL AND ${ident(col)} IS NOT NULL`, ctx),
          { sql: `-- MANUAL: deploy code that reads ${tmp}; verify with: driftguard verify`, transactional: true, kind: "manual" },
          {
            sql: `ALTER TABLE ${t} RENAME COLUMN ${ident(col)} TO ${ident(`${col}_old`)};\nALTER TABLE ${t} RENAME COLUMN ${ident(tmp)} TO ${ident(col)}`,
            transactional: true,
            kind: "ddl",
            note: "Swap in ONE short transaction (both renames are instant).",
          },
          { sql: `-- CONTRACT (data-lossy, run after the app is stable): ALTER TABLE ${t} DROP COLUMN ${ident(`${col}_old`)}`, transactional: true, kind: "manual" },
        ],
        explanation: `Changing ${col} to ${newType} rewrites the whole table and every index under ACCESS EXCLUSIVE. Expand/contract adds a new column, backfills it in batches, swaps names in an instant transaction, and drops the old column later.`,
      };
    }

    default:
      return null;
  }
}

function addColumnRule(stmt: ParsedStatement, col: AstNode, key: string, a: StatementAnalysis, ctx: Ctx): RuleResult {
  const constraints: AstNode[] = (col.constraints ?? []).map((c: AstNode) => c.Constraint);
  const notNull = constraints.some((c) => c.contype === "CONSTR_NOTNULL");
  const def = constraints.find((c) => c.contype === "CONSTR_DEFAULT");
  const unsupported = constraints.some((c) => ["CONSTR_GENERATED", "CONSTR_IDENTITY"].includes(c.contype));
  const type = formatTypeName(col.typeName);

  // Safe as written: nullable, or NOT NULL with a constant default (instant since PG 11).
  const failsOnExistingRows = notNull && !def;
  if (!a.rewritesTable && !failsOnExistingRows) return null;
  if (unsupported || ["serial", "bigserial", "smallserial", "serial4", "serial8", "serial2"].includes(type)) return null;

  const t = tableRef(key);
  const c = ident(col.colname);
  // The DEFAULT expression's text: from its constraint's location to the next
  // constraint's location (AST expression locations point at operators, not starts).
  const defaultExpr = def ? constraintText(stmt, constraints, def).replace(/^DEFAULT\s+/i, "") : null;

  const steps: RewriteStep[] = [
    { sql: `ALTER TABLE ${t} ADD COLUMN ${c} ${type}`, transactional: true, kind: "ddl", note: "Expand: nullable, no default = metadata-only." },
  ];
  if (defaultExpr) {
    steps.push({ sql: `ALTER TABLE ${t} ALTER COLUMN ${c} SET DEFAULT ${defaultExpr}`, transactional: true, kind: "ddl", note: "New rows get the default from now on." });
  }
  const value = defaultExpr ?? "NULL /* TODO: value for existing rows */";
  steps.push(backfillOrManual(key, `${c} = ${value}`, `${c} IS NULL`, ctx));
  if (notNull) steps.push(...setNotNullSteps(key, col.colname));

  return {
    rule: "add_column_expand",
    steps,
    explanation: a.rewritesTable
      ? "A volatile DEFAULT makes ADD COLUMN rewrite the whole table under ACCESS EXCLUSIVE. Instead: add the column nullable, set the default for new rows, backfill old rows in batches, then enforce NOT NULL without a blocking scan."
      : "ADD COLUMN ... NOT NULL without a DEFAULT fails on a table that has rows. Add it nullable, backfill, then enforce NOT NULL via a validated CHECK.",
  };
}

function renameColumnRule(key: string, from: string, to: string, ctx: Ctx): RuleResult {
  const t = tableRef(key);
  const type = ctx.schema?.tables[key]?.columns[from]?.type ?? "/* TODO: type of " + from + " */";
  return {
    rule: "rename_column_expand_contract",
    steps: [
      { sql: `ALTER TABLE ${t} ADD COLUMN ${ident(to)} ${type}`, transactional: true, kind: "ddl" },
      { sql: `-- MANUAL: deploy code that writes both ${from} and ${to}`, transactional: true, kind: "manual" },
      backfillOrManual(key, `${ident(to)} = ${ident(from)}`, `${ident(to)} IS DISTINCT FROM ${ident(from)}`, ctx),
      { sql: `-- MANUAL: deploy code that reads and writes only ${to}`, transactional: true, kind: "manual" },
      { sql: `-- CONTRACT (data-lossy, later): ALTER TABLE ${t} DROP COLUMN ${ident(from)}`, transactional: true, kind: "manual" },
    ],
    explanation: "A rename is instant, but every running instance of the app still uses the old name and breaks at that moment. Expand/contract keeps both names working during the deploy.",
  };
}

/** The four-step, non-blocking way to make a column NOT NULL (PG 12+). */
function setNotNullSteps(key: string, column: string): RewriteStep[] {
  const t = tableRef(key);
  const c = ident(column);
  const check = ident(constraintName(key.split(".")[1]!, column, "not_null"));
  return [
    { sql: `ALTER TABLE ${t} ADD CONSTRAINT ${check} CHECK (${c} IS NOT NULL) NOT VALID`, transactional: true, kind: "ddl", note: "Instant." },
    { sql: `ALTER TABLE ${t} VALIDATE CONSTRAINT ${check}`, transactional: true, kind: "ddl", note: "Scans without blocking reads or writes." },
    { sql: `ALTER TABLE ${t} ALTER COLUMN ${c} SET NOT NULL`, transactional: true, kind: "ddl", note: "Instant: Postgres uses the validated CHECK instead of scanning." },
    { sql: `ALTER TABLE ${t} DROP CONSTRAINT ${check}`, transactional: true, kind: "ddl", note: "The CHECK is now redundant." },
  ];
}

function backfillOrManual(key: string, setClause: string, onlyWhere: string, ctx: Ctx): RewriteStep {
  return (
    batchLoop(key, `UPDATE ${tableRef(key)} SET ${setClause} WHERE ${onlyWhere}`, true, ctx) ?? {
      sql: `-- MANUAL: backfill in batches by primary-key range, one short transaction each:\n-- UPDATE ${tableRef(key)} SET ${setClause} WHERE ${onlyWhere} AND <pk> BETWEEN <start> AND <end>;`,
      transactional: false,
      kind: "manual",
      note: "Automatic batching needs a single integer primary key (and a database connection to know it).",
    }
  );
}

/**
 * Wraps a write in a DO loop over the integer primary key. COMMIT inside DO (PG 11+)
 * makes each batch its own short transaction. The batch condition is appended to
 * `write` (with AND if it already has a WHERE). Re-running after a failure is safe:
 * rows already done no longer match the backfill's WHERE.
 */
function batchLoop(key: string, write: string, hasWhere: boolean, ctx: Ctx): RewriteStep | null {
  const table = ctx.schema?.tables[key];
  const pk = table?.primaryKey;
  if (!table || !pk || pk.length !== 1) return null;
  const pkCol = pk[0]!;
  if (!["smallint", "integer", "bigint"].includes(table.columns[pkCol]?.type ?? "")) return null;

  const p = ident(pkCol);
  const range = `${p} >= batch_start AND ${p} < batch_start + ${ctx.batchSize}`;
  const statement = `${write} ${hasWhere ? "AND" : "WHERE"} ${range}`;

  return {
    sql: [
      "-- The loop is ONE statement, so lift statement_timeout for it; each batch inside is short.",
      "SET statement_timeout = 0;",
      "DO $$",
      "DECLARE",
      "  batch_start bigint;",
      "  max_id bigint;",
      "BEGIN",
      `  SELECT min(${p}), max(${p}) INTO batch_start, max_id FROM ${tableRef(key)};`,
      "  WHILE batch_start <= max_id LOOP",
      `    ${statement};`,
      "    COMMIT;                  -- each batch is its own short transaction (PG 11+)",
      "    PERFORM pg_sleep(0.05);  -- let replicas and autovacuum keep up",
      `    batch_start := batch_start + ${ctx.batchSize};`,
      "  END LOOP;",
      "END $$;",
      `SET statement_timeout = '${ctx.statementTimeout}'`,
    ].join("\n"),
    transactional: false,
    kind: "backfill",
    note: `Batches of ${ctx.batchSize} rows by ${pkCol}.`,
  };
}

/** Source text of one column constraint, e.g. "DEFAULT now()", bounded by the next constraint. */
function constraintText(stmt: ParsedStatement, all: AstNode[], c: AstNode): string {
  const next = all.map((x) => x.location).filter((loc) => loc > c.location).sort((x, y) => x - y)[0];
  return sliceBytes(stmt, c.location, next ?? stmt.end).replace(/;$/, "").trim();
}

function explainUnchanged(a: StatementAnalysis): string {
  if (a.operation.startsWith("ALTER TABLE (") && a.risk !== "low") {
    return "Several sub-commands share one ACCESS EXCLUSIVE lock. Split it into one ALTER TABLE per change so each can be rewritten safely.";
  }
  if (a.dataLoss) return "No safe rewrite: this permanently removes data. Run it only in a contract phase, after the application no longer uses the object, with a backup.";
  if (a.risk === "low" || a.risk === "medium") return "Already safe (or metadata-only); the script's lock_timeout protects it from the lock queue.";
  return "No automatic rewrite for this statement; review it manually.";
}

function renderScript(statements: StatementRewrite[], lockTimeout: string, statementTimeout: string): string {
  const lines = [
    "-- Generated by DriftGuard. Review every step before running it.",
    "-- If a step fails with a lock timeout, nothing was blocked for long: just retry it.",
    `SET lock_timeout = '${lockTimeout}';`,
    `SET statement_timeout = '${statementTimeout}';`,
  ];
  for (const s of statements) {
    lines.push("", `-- [${s.index + 1}] ${s.original.replace(/\s+/g, " ")}`);
    lines.push(`--     ${s.rule ? `rule: ${s.rule}` : "unchanged"} (was ${s.analysis.risk} risk)`);
    if (!s.rule && s.analysis.risk !== "low") lines.push(`-- ${s.explanation}`);
    for (const step of s.steps) {
      if (step.note) lines.push(`-- ${step.note}`);
      if (!step.transactional && step.kind !== "manual") lines.push("-- (run outside a transaction block)");
      lines.push(step.kind === "manual" ? step.sql : `${step.sql.replace(/;\s*$/, "")};`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Would a safe-rewrite rule fire for this statement? Used by the plan validator:
 * if DriftGuard knows a safer way to do it, a plan that does it the risky way is rejected.
 */
export function unsafeRuleFor(stmt: ParsedStatement, a: StatementAnalysis, schema?: Schema): RuleId | null {
  return applyRules(stmt, a, { schema, batchSize: 10_000, statementTimeout: "30min" })?.rule ?? null;
}
