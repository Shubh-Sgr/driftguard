import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScratchDatabase, dropScratchDatabase, runAsAdmin, withDatabase } from "../../evals/lib/scratch.js";
import { SOURCE_RO_URL, TARGET_ADMIN_URL, TARGET_RO_URL } from "./env.js";

// End-to-end over the real protocol: spawn `pgvouch mcp` as a child process and talk
// JSON-RPC over stdio with the official SDK client, exactly like Claude Code or Cursor.
const DB = "dg_test_mcp";
let client: Client;

beforeAll(async () => {
  await createScratchDatabase(TARGET_ADMIN_URL, DB);
  await runAsAdmin(TARGET_ADMIN_URL, DB, `
    DROP INDEX transactions_account_created_idx;
    UPDATE accounts SET balance = balance + 1 WHERE id = 4242;
  `);
  client = new Client({ name: "pgvouch-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/cli/index.ts", "mcp"],
      env: {
        ...(process.env as Record<string, string>),
        SOURCE_DATABASE_URL: SOURCE_RO_URL,
        TARGET_DATABASE_URL: withDatabase(TARGET_RO_URL, DB),
        PGVOUCH_LLM: "none",
      },
      stderr: "ignore",
    }),
  );
});

afterAll(async () => {
  await client?.close();
  await dropScratchDatabase(TARGET_ADMIN_URL, DB);
});

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { isError: res.isError ?? false, text: res.content[0]!.text };
};

describe("MCP server (F8)", () => {
  it("lists the six read-only tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["analyze_locks", "check_lock_queue", "detect_drift", "find_differing_rows", "plan_migration", "suggest_safe_rewrite", "verify_data"]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("detect_drift finds the dropped index", async () => {
    const r = JSON.parse((await call("detect_drift")).text);
    expect(r.items).toEqual([expect.objectContaining({ kind: "index_missing", name: "transactions_account_created_idx" })]);
  });

  it("find_differing_rows returns keys and columns but no values by default", async () => {
    const r = JSON.parse((await call("find_differing_rows", { table: "accounts" })).text);
    expect(r.differingRows).toEqual([{ kind: "changed", key: { id: "4242" }, columns: ["balance"] }]);
    const withValues = JSON.parse((await call("find_differing_rows", { table: "accounts", includeValues: true })).text);
    expect(withValues.differingRows[0].source).toBeDefined();
  });

  it("analyze_locks and suggest_safe_rewrite work on submitted SQL", async () => {
    const locks = JSON.parse((await call("analyze_locks", { sql: "CREATE INDEX i ON transactions (amount)" })).text);
    expect(locks.statements[0]).toMatchObject({ lockMode: "SHARE", blocksWrites: true });
    // The exact level depends on the table size (high at 1M rows, medium for a small CI seed).
    expect(["medium", "high", "critical"]).toContain(locks.statements[0].risk);
    const rewrite = JSON.parse((await call("suggest_safe_rewrite", { sql: "CREATE INDEX i ON transactions (amount)" })).text);
    expect(rewrite.script).toContain("CREATE INDEX CONCURRENTLY i ON transactions (amount);");
  });

  it("check_lock_queue gives a live verdict for submitted SQL", async () => {
    const r = JSON.parse((await call("check_lock_queue", { sql: "SELECT * FROM accounts" })).text);
    expect(r).toMatchObject({ verdict: "safe_now", statements: [{ operation: "SELECT", verdict: "safe_now" }] });
  });

  it("plan_migration returns SQL for a human, rules-only when no LLM is configured", async () => {
    const r = JSON.parse((await call("plan_migration")).text);
    expect(r.plan.author).toBe("rules");
    expect(r.sql).toContain("CREATE INDEX CONCURRENTLY transactions_account_created_idx");
  });

  it("returns tool errors instead of crashing (e.g. SQL that doesn't parse)", async () => {
    const r = await call("analyze_locks", { sql: "ALTER TABLE x ADD COLUM y int" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/syntax error/);
  });
});
