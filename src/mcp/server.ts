import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { renderPlanSql } from "../plan/render.js";
import { PgVouch } from "../service.js";
import type { RowDiff } from "../verify/bisect.js";
import { VERSION } from "../version.js";

// Every tool is read-only: it reads catalogs/data through the read-only pools and
// returns text. None of them can write to a database; plans are returned as SQL for a
// human to review. Connection strings come from the environment, never from tool input.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Runs a tool body; errors become tool errors the model can read, not crashes. */
async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const result = await fn();
    return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
  }
}

export function buildMcpServer(dg: PgVouch): McpServer {
  const server = new McpServer({ name: "pgvouch", version: VERSION });

  server.registerTool(
    "detect_drift",
    {
      title: "Detect schema drift",
      description:
        "Compare the SOURCE (reference) and TARGET PostgreSQL schemas: tables, columns, types, nullability, defaults, indexes, constraints, sequences. Returns every difference with a severity. 'missing' = in source but not target; 'extra' = only in target.",
      inputSchema: { schemas: z.array(z.string()).optional().describe("Schemas to compare; default ['public']") },
      annotations: READ_ONLY,
    },
    ({ schemas }) => run(() => dg.detectDrift(schemas)),
  );

  server.registerTool(
    "verify_data",
    {
      title: "Verify data with chunked checksums",
      description:
        "Prove that table data is identical on source and target by comparing MD5 hashes of primary-key chunks computed inside Postgres (no rows are transferred). Returns per-table status and the key ranges of mismatched chunks, plus a check that every identity/serial sequence on the target is ahead of its data (a sequence left behind makes the next INSERT fail with a duplicate key). If the target is still being replicated to, set recheck: differences are looked at again after a delay and only those that never catch up are reported. Use find_differing_rows to drill into a mismatched table.",
      inputSchema: {
        tables: z.array(z.string()).optional().describe("Tables to verify, e.g. ['transactions']; default all"),
        schemas: z.array(z.string()).optional().describe("Schemas to verify; default ['public']"),
        chunkSize: z.number().int().min(100).max(1_000_000).optional().describe("Rows per chunk; default 10000"),
        ...RECHECK_INPUT,
      },
      annotations: READ_ONLY,
    },
    ({ tables, schemas, chunkSize, recheck, recheckDelaySeconds }) =>
      run(() => dg.verifyData({ tables, schemas, chunkSize, ...recheckOptions(recheck, recheckDelaySeconds) })),
  );

  server.registerTool(
    "find_differing_rows",
    {
      title: "Find the exact differing rows",
      description:
        "For one table, bisect mismatched chunks (binary search over checksums) to find the exact rows that differ: missing on target, extra on target, or changed (with the changed column names). By default returns primary keys and column names only, not values.",
      inputSchema: {
        table: z.string().describe("Table name, e.g. 'transactions' or 'public.transactions'"),
        maxRows: z.number().int().min(1).max(1000).optional().describe("Stop after this many differing rows; default 100"),
        includeValues: z.boolean().optional().describe("Also return the source/target values of differing rows (may contain personal data); default false"),
        ...RECHECK_INPUT,
      },
      annotations: READ_ONLY,
    },
    ({ table, maxRows, includeValues, recheck, recheckDelaySeconds }) =>
      run(async () => {
        const result = await dg.findDifferingRows(table, { maxRows: maxRows ?? 100, ...recheckOptions(recheck, recheckDelaySeconds) });
        // Row values can contain personal data (and text that looks like instructions),
        // so they're only sent to the model when explicitly asked for.
        return includeValues ? result : { ...result, differingRows: result.differingRows?.map(withoutValues) };
      }),
  );

  server.registerTool(
    "analyze_locks",
    {
      title: "Analyze migration lock impact",
      description:
        "Parse a SQL migration with PostgreSQL's own parser and predict, per statement: the table lock taken, whether it blocks reads/writes, whether it scans or rewrites the table, and a risk level using the target table's size. Also warns about missing lock_timeout and CONCURRENTLY inside transactions.",
      inputSchema: { sql: z.string().min(1).describe("The migration SQL (one or more statements)") },
      annotations: READ_ONLY,
    },
    ({ sql }) => run(() => dg.analyzeLocks(sql)),
  );

  server.registerTool(
    "check_lock_queue",
    {
      title: "Is it safe to run this migration right now?",
      description:
        "Live check on the TARGET: for each statement, compares the table lock it needs with the locks other sessions hold or are waiting for right now (pg_locks, full Postgres conflict table), and lists open transactions that CREATE INDEX CONCURRENTLY would wait for. Verdict: safe_now or would_wait (with the sessions: pid, user, application, state, transaction age, lock mode). Never returns other sessions' query text and never terminates anything. Without pg_read_all_stats, states and ages are unknown ('limited' visibility).",
      inputSchema: { sql: z.string().min(1).describe("The migration SQL to check") },
      // Not idempotent: the answer depends on what other sessions are doing this moment.
      annotations: { ...READ_ONLY, idempotentHint: false },
    },
    ({ sql }) => run(() => dg.preflight(sql)),
  );

  server.registerTool(
    "suggest_safe_rewrite",
    {
      title: "Rewrite risky DDL safely",
      description:
        "Rewrite risky DDL into safe, non-blocking steps using deterministic rules (CREATE INDEX CONCURRENTLY, NOT VALID + VALIDATE, expand/contract for NOT NULL columns and type changes, batched backfills). Returns a commented script that starts with SET lock_timeout and statement_timeout. It is NOT executed.",
      inputSchema: { sql: z.string().min(1).describe("The migration SQL to rewrite") },
      annotations: READ_ONLY,
    },
    ({ sql }) =>
      run(async () => {
        const r = await dg.suggestSafeRewrite(sql);
        return { script: r.script, statements: r.statements.map(({ analysis, ...rest }) => ({ ...rest, riskBefore: analysis.risk })) };
      }),
  );

  server.registerTool(
    "plan_migration",
    {
      title: "Plan a safe migration",
      description:
        "Build an ordered, safe migration plan that makes TARGET match SOURCE. If an LLM is configured, its plan must pass a validator (objects exist, only allow-listed statements, no unsafe DDL) and then a shadow run: PgVouch starts a disposable local Postgres container, copies the target's schema (no data) into it, applies the plan as a non-superuser and checks the result matches SOURCE. Otherwise the deterministic rules-only plan is returned. `plan.acceptedBy` and the first lines of `sql` say how the plan was accepted. Risk and reversibility are computed by PgVouch. The source and target databases are only read; the plan is returned as SQL for a human to review and is never run on them.",
      inputSchema: { useLlm: z.boolean().optional().describe("Set false for a rules-only plan; default uses the configured LLM") },
      annotations: { ...READ_ONLY, idempotentHint: false },
    },
    ({ useLlm }) =>
      run(async () => {
        const { plan } = await dg.plan({ useLlm });
        return { sql: renderPlanSql(plan), plan };
      }),
  );

  return server;
}

/** Keeps what identifies the difference (kind, primary key, changed columns); drops the values. */
function withoutValues(row: RowDiff): { kind: RowDiff["kind"]; key: Record<string, string>; columns?: string[]; sourceChanging?: boolean } {
  const flag = row.sourceChanging ? { sourceChanging: true } : {};
  return row.kind === "changed" ? { kind: row.kind, key: row.key, columns: row.columns, ...flag } : { kind: row.kind, key: row.key, ...flag };
}

// Kept small: a tool call waits for every recheck (at most 5 x 60 s).
const RECHECK_INPUT = {
  recheck: z.number().int().min(1).max(5).optional().describe("Target still being replicated to: look at differences again up to this many times and report only those that never catch up; default off"),
  recheckDelaySeconds: z.number().int().min(1).max(60).optional().describe("Wait before each recheck; default 5"),
};

const recheckOptions = (recheck?: number, delaySeconds?: number) => ({ recheck, recheckDelayMs: (delaySeconds ?? 5) * 1000 });

/** Entry point for `pgvouch mcp`: JSON-RPC over stdin/stdout. */
export async function startMcpServer(config: Config): Promise<void> {
  const dg = new PgVouch(config);
  const server = buildMcpServer(dg);
  // stdout carries the protocol, so any logging must go to stderr.
  await server.connect(new StdioServerTransport());
  console.error(`pgvouch MCP server ${VERSION} ready on stdio`);
  const shutdown = async () => {
    await server.close();
    await dg.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
