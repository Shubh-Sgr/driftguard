#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { Command, InvalidArgumentError, Option } from "commander";
import { loadConfig, redactUrl } from "../config.js";
import { analyzeMigration } from "../locks/analyze.js";
import { RISK_ORDER, type Risk } from "../locks/risk.js";
import { acceptanceNote, renderPlanSql } from "../plan/render.js";
import { verifyReceipt, type SignedReceipt } from "../receipt/receipt.js";
import { reviewFile, reviewMarkdown, reviewMaxRisk } from "../review/review.js";
import { rewriteMigration } from "../rewrite/rewrite.js";
import { PgVouch } from "../service.js";
import { VERSION } from "../version.js";
import { inspectConnection } from "./doctor.js";
import { formatDrift, formatLocks, formatPreflight, formatShadow, formatVerify } from "./format.js";

const program = new Command()
  .name("pgvouch")
  .description("Safe PostgreSQL migrations: detect drift, predict locks, rewrite risky DDL, verify data.")
  .version(VERSION);

/**
 * Config for CLI commands: reads ./.env when there is one, so an installed `pgvouch` works like
 * `npm run cli`. Variables already set in the environment win. The MCP server doesn't do this:
 * its settings come only from the MCP client config.
 */
function cliConfig() {
  try {
    process.loadEnvFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return loadConfig();
}

/** Opens both read-only connections for one command and always closes them. */
async function withPgVouch<T>(fn: (dg: PgVouch) => Promise<T>): Promise<T> {
  const dg = new PgVouch(cliConfig());
  try {
    return await fn(dg);
  } finally {
    await dg.close();
  }
}

/** Option parser: a whole number >= min, so bad input fails here instead of as a SQL error. */
const intAtLeast = (min: number) => (value: string) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new InvalidArgumentError(`must be a whole number >= ${min}.`);
  return n;
};

const print = (json: boolean | undefined, data: unknown, text: () => string) =>
  console.log(json ? JSON.stringify(data, null, 2) : text());

program
  .command("doctor")
  .description("Check both database connections and confirm they are read-only")
  .action(() =>
    withPgVouch(async (dg) => {
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
        console.error("\nUnsafe: PgVouch should connect with a read-only role (see docker/seed/00_roles.sql).");
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
    withPgVouch(async (dg) => {
      const report = await dg.detectDrift(opts.schema);
      print(opts.json, report, () => formatDrift(report));
      if (!report.identical) process.exitCode = 1;
    }),
  );

program
  .command("verify")
  .description("Prove table data is identical with chunked checksums, and check sequences (exit code 1 if not)")
  .option("--table <names...>", "only these tables")
  .option("--schema <names...>", "schemas to verify (default public)")
  .option("--chunk-size <n>", "rows per chunk (>= 100)", intAtLeast(100), 10_000)
  .option("--rows", "bisect mismatched chunks to list the exact differing rows")
  .option("--max-rows <n>", "stop after this many differing rows", intAtLeast(1), 1000)
  .option("--recheck <rounds>", "on a target still being replicated to: look at differences again up to this many times and report only those that never catch up", intAtLeast(1))
  .option("--recheck-delay <seconds>", "wait before each recheck", intAtLeast(1), 5)
  .option("--json", "print JSON")
  .action((opts) =>
    withPgVouch(async (dg) => {
      const report = await dg.verifyData({
        tables: opts.table,
        schemas: opts.schema,
        chunkSize: opts.chunkSize,
        findRows: opts.rows,
        maxRows: opts.maxRows,
        recheck: opts.recheck,
        recheckDelayMs: opts.recheckDelay * 1000,
      });
      print(opts.json, report, () => formatVerify(report));
      if (!report.identical || !report.sequencesOk) process.exitCode = 1;
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
    const analysis = opts.offline ? await analyzeMigration(sql) : await withPgVouch((dg) => dg.analyzeLocks(sql));
    print(opts.json, analysis, () => formatLocks(analysis));
    if (opts.failOn && RISK_ORDER.indexOf(analysis.maxRisk) >= RISK_ORDER.indexOf(opts.failOn as Risk)) process.exitCode = 1;
  });

program
  .command("preflight <file>")
  .description("Check whether a migration would have to wait for locks on the target right now (exit code 1 if it would)")
  .option("--json", "print JSON")
  .action(async (file, opts) => {
    const sql = await readFile(file, "utf8");
    const report = await withPgVouch((dg) => dg.preflight(sql));
    print(opts.json, report, () => formatPreflight(report));
    if (report.verdict === "would_wait") process.exitCode = 1;
  });

program
  .command("review <files...>")
  .description("Offline lock analysis + safe rewrites for migration files, e.g. as a pull request comment (no database needed)")
  .addOption(new Option("--format <format>", "output format").choices(["text", "markdown", "json"]).default("text"))
  .option("--out <file>", "write the report to a file instead of stdout")
  .addOption(new Option("--fail-on <risk>", "exit code 1 at or above this risk").choices(RISK_ORDER))
  .action(async (files: string[], opts) => {
    const reviews = await Promise.all(files.map(async (f) => reviewFile(f, await readFile(f, "utf8"))));
    const output =
      opts.format === "markdown" ? reviewMarkdown(reviews)
      : opts.format === "json" ? JSON.stringify(reviews, null, 2)
      : reviews.map((r) => `== ${r.path} ==\n${r.analysis ? formatLocks(r.analysis) : `could not analyze: ${r.error}`}`).join("\n\n");
    if (opts.out) await writeFile(opts.out, `${output}\n`);
    else console.log(output);
    // A file that can't be parsed fails the check too: we can't vouch for it.
    const failed = opts.failOn && (reviews.some((r) => r.error) || RISK_ORDER.indexOf(reviewMaxRisk(reviews)) >= RISK_ORDER.indexOf(opts.failOn as Risk));
    if (failed) process.exitCode = 1;
  });

program
  .command("rewrite <file>")
  .description("Rewrite risky DDL in a migration file into safe, non-blocking steps")
  .option("--offline", "don't connect to the target (no primary keys/sizes: backfills become manual)")
  .option("--out <file>", "write the script to a file")
  .option("--json", "print JSON")
  .action(async (file, opts) => {
    const sql = await readFile(file, "utf8");
    const result = opts.offline ? await rewriteMigration(sql) : await withPgVouch((dg) => dg.suggestSafeRewrite(sql));
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
    withPgVouch(async (dg) => {
      const { drift, plan } = await dg.plan({ useLlm: opts.llm });
      const sql = renderPlanSql(plan, { allowDataLoss: opts.allowDataLoss });
      if (opts.out) await writeFile(opts.out, sql);
      print(opts.json, { drift, plan }, () => {
        const rejected = plan.attempts.filter((a) => !a.valid);
        const notes = rejected.map((a) => `-- LLM attempt ${a.attempt} rejected at the ${a.stage} stage:\n${a.errors.map((e) => `--   ${e}`).join("\n")}`);
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
    withPgVouch(async (dg) => {
      const result = await dg.shadow({ useLlm: opts.llm, allowDataLoss: opts.allowDataLoss });
      print(opts.json, result, () => `Plan: ${acceptanceNote(result.plan)}\n${formatShadow(result.shadow)}`);
      if (result.shadow.verdict === "fail") process.exitCode = 1;
    }),
  );

program
  .command("receipt")
  .description("Run drift + verification + plan (+ shadow) and write a hashed receipt")
  .option("--no-llm", "rules-only plan")
  .option("--shadow", "include a shadow run")
  .option("--out <file>", "receipt file", "pgvouch-receipt.json")
  .action((opts) =>
    withPgVouch(async (dg) => {
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
    const receipt = JSON.parse(await readFile(file, "utf8")) as SignedReceipt;
    if (typeof receipt?.integrity?.hash !== "string") {
      console.log("NOT A RECEIPT: no integrity block. Was this file written by `pgvouch receipt`?");
      process.exitCode = 1;
      return;
    }
    const result = verifyReceipt(receipt);
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
