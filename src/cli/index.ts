#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { Command, Option } from "commander";
import { loadConfig, redactUrl } from "../config.js";
import { analyzeMigration } from "../locks/analyze.js";
import { RISK_ORDER, type Risk } from "../locks/risk.js";
import { renderPlanSql } from "../plan/render.js";
import { verifyReceipt, type SignedReceipt } from "../receipt/receipt.js";
import { rewriteMigration } from "../rewrite/rewrite.js";
import { DriftGuard } from "../service.js";
import { VERSION } from "../version.js";
import { inspectConnection } from "./doctor.js";
import { formatDrift, formatLocks, formatShadow, formatVerify } from "./format.js";

const program = new Command()
  .name("driftguard")
  .description("Safe PostgreSQL migrations: detect drift, predict locks, rewrite risky DDL, verify data.")
  .version(VERSION);

/** Opens both read-only connections for one command and always closes them. */
async function withDriftGuard<T>(fn: (dg: DriftGuard) => Promise<T>): Promise<T> {
  const dg = new DriftGuard(loadConfig());
  try {
    return await fn(dg);
  } finally {
    await dg.close();
  }
}

const print = (json: boolean | undefined, data: unknown, text: () => string) =>
  console.log(json ? JSON.stringify(data, null, 2) : text());

program
  .command("doctor")
  .description("Check both database connections and confirm they are read-only")
  .action(() =>
    withDriftGuard(async (dg) => {
      const config = loadConfig();
      let unsafe = false;
      for (const [label, pool, url] of [["source", dg.source, config.sourceUrl], ["target", dg.target, config.targetUrl]] as const) {
        const r = await inspectConnection(pool);
        console.log(`${label}: ${redactUrl(url)}`);
        console.log(`  postgres ${r.serverVersion}, user=${r.user}, tables=${r.tableCount}`);
        console.log(`  read_only=${r.readOnly}, statement_timeout=${r.statementTimeout}`);
        console.log(`  write privileges: ${r.canWriteAnyTable ? "YES (unsafe)" : "none"}`);
        if (!r.readOnly || r.canWriteAnyTable) unsafe = true;
      }
      if (unsafe) {
        console.error("\nUnsafe: DriftGuard should connect with a read-only role (see docker/seed/00_roles.sql).");
        process.exitCode = 1;
      }
    }),
  );

program
  .command("diff")
  .description("Detect schema drift between source and target (exit code 1 if any)")
  .option("--schema <names...>", "schemas to compare", ["public"])
  .option("--json", "print JSON")
  .action((opts) =>
    withDriftGuard(async (dg) => {
      const report = await dg.detectDrift(opts.schema);
      print(opts.json, report, () => formatDrift(report));
      if (!report.identical) process.exitCode = 1;
    }),
  );

program
  .command("verify")
  .description("Prove table data is identical with chunked checksums (exit code 1 if not)")
  .option("--table <names...>", "only these tables")
  .option("--chunk-size <n>", "rows per chunk", (v) => Number(v), 10_000)
  .option("--rows", "bisect mismatched chunks to list the exact differing rows")
  .option("--max-rows <n>", "stop after this many differing rows", (v) => Number(v), 1000)
  .option("--json", "print JSON")
  .action((opts) =>
    withDriftGuard(async (dg) => {
      const report = await dg.verifyData({ tables: opts.table, chunkSize: opts.chunkSize, findRows: opts.rows, maxRows: opts.maxRows });
      print(opts.json, report, () => formatVerify(report));
      if (!report.identical) process.exitCode = 1;
    }),
  );

program
  .command("locks <file>")
  .description("Predict the locks and risk of each statement in a migration file")
  .option("--offline", "don't connect to the target (no table sizes)")
  .addOption(new Option("--fail-on <risk>", "exit code 1 at or above this risk").choices(RISK_ORDER))
  .option("--json", "print JSON")
  .action(async (file, opts) => {
    const sql = await readFile(file, "utf8");
    const analysis = opts.offline ? await analyzeMigration(sql) : await withDriftGuard((dg) => dg.analyzeLocks(sql));
    print(opts.json, analysis, () => formatLocks(analysis));
    if (opts.failOn && RISK_ORDER.indexOf(analysis.maxRisk) >= RISK_ORDER.indexOf(opts.failOn as Risk)) process.exitCode = 1;
  });

program
  .command("rewrite <file>")
  .description("Rewrite risky DDL in a migration file into safe, non-blocking steps")
  .option("--offline", "don't connect to the target (no primary keys/sizes: backfills become manual)")
  .option("--out <file>", "write the script to a file")
  .option("--json", "print JSON")
  .action(async (file, opts) => {
    const sql = await readFile(file, "utf8");
    const result = opts.offline ? await rewriteMigration(sql) : await withDriftGuard((dg) => dg.suggestSafeRewrite(sql));
    if (opts.out) await writeFile(opts.out, result.script);
    print(opts.json, result, () => result.script);
  });

program
  .command("plan")
  .description("Plan a safe migration that makes target match source (LLM + guardrails, or rules only)")
  .option("--no-llm", "rules-only plan; nothing is sent to any LLM")
  .option("--allow-data-loss", "include contract (data-lossy) steps uncommented")
  .option("--out <file>", "write the SQL script to a file")
  .option("--json", "print JSON")
  .action((opts) =>
    withDriftGuard(async (dg) => {
      const { drift, plan } = await dg.plan({ useLlm: opts.llm });
      const sql = renderPlanSql(plan, { allowDataLoss: opts.allowDataLoss });
      if (opts.out) await writeFile(opts.out, sql);
      print(opts.json, { drift, plan }, () => {
        const rejected = plan.attempts.filter((a) => !a.valid);
        const notes = rejected.map((a) => `-- LLM attempt ${a.attempt} rejected:\n${a.errors.map((e) => `--   ${e}`).join("\n")}`);
        return [...notes, sql].join("\n");
      });
    }),
  );

program
  .command("shadow")
  .description("Plan, then apply the plan to a disposable Postgres container to prove it works")
  .option("--no-llm", "rules-only plan")
  .option("--allow-data-loss", "also apply contract (data-lossy) steps in the shadow")
  .option("--json", "print JSON")
  .action((opts) =>
    withDriftGuard(async (dg) => {
      const result = await dg.shadow({ useLlm: opts.llm, allowDataLoss: opts.allowDataLoss });
      print(opts.json, result, () => formatShadow(result.shadow));
      if (result.shadow.verdict === "fail") process.exitCode = 1;
    }),
  );

program
  .command("receipt")
  .description("Run drift + verification + plan (+ shadow) and write a hashed receipt")
  .option("--no-llm", "rules-only plan")
  .option("--shadow", "include a shadow run")
  .option("--out <file>", "receipt file", "driftguard-receipt.json")
  .action((opts) =>
    withDriftGuard(async (dg) => {
      const results: Record<string, unknown> = {};
      results.drift = await dg.detectDrift();
      results.verification = await dg.verifyData({ findRows: true, maxRows: 100 });
      if (opts.shadow) {
        const { plan, shadow } = await dg.shadow({ useLlm: opts.llm });
        Object.assign(results, { plan, shadow });
      } else {
        results.plan = (await dg.plan({ useLlm: opts.llm })).plan;
      }
      const receipt = dg.receipt(results);
      await writeFile(opts.out, `${JSON.stringify(receipt, null, 2)}\n`);
      console.log(`Wrote ${opts.out}\nsha256: ${receipt.integrity.hash}`);
    }),
  );

program
  .command("receipt-verify <file>")
  .description("Check that a receipt has not been modified since it was written")
  .action(async (file) => {
    const result = verifyReceipt(JSON.parse(await readFile(file, "utf8")) as SignedReceipt);
    console.log(result.valid ? `OK: receipt intact (sha256 ${result.actual})` : `MODIFIED: expected ${result.expected}, got ${result.actual}`);
    if (!result.valid) process.exitCode = 1;
  });

program
  .command("mcp")
  .description("Start the MCP server on stdio (for Claude Code, Cursor, Gemini CLI)")
  .action(async () => {
    const { startMcpServer } = await import("../mcp/server.js");
    await startMcpServer(loadConfig());
  });

// parseAsync so errors thrown in async actions reach this catch.
program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
