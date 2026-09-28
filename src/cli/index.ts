#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig, redactUrl } from "../config.js";
import { createPool } from "../db.js";
import { inspectConnection } from "./doctor.js";

const program = new Command()
  .name("driftguard")
  .description("Safe PostgreSQL migrations: detect drift, predict locks, verify data.")
  .version("0.1.0");

program
  .command("doctor")
  .description("Check both database connections and confirm they are read-only")
  .action(async () => {
    const config = loadConfig();
    let unsafe = false;

    for (const [label, url] of [
      ["source", config.sourceUrl],
      ["target", config.targetUrl],
    ] as const) {
      const pool = createPool(url, { statementTimeoutMs: config.statementTimeoutMs });
      try {
        const r = await inspectConnection(pool);
        console.log(`${label}: ${redactUrl(url)}`);
        console.log(`  postgres ${r.serverVersion}, user=${r.user}, tables=${r.tableCount}`);
        console.log(`  read_only=${r.readOnly}, statement_timeout=${r.statementTimeout}`);
        console.log(`  write privileges: ${r.canWriteAnyTable ? "YES (unsafe)" : "none"}`);
        if (!r.readOnly || r.canWriteAnyTable) unsafe = true;
      } finally {
        await pool.end();
      }
    }

    if (unsafe) {
      console.error("\nUnsafe: DriftGuard should connect with a read-only role (see docker/seed/00_roles.sql).");
      process.exitCode = 1;
    }
  });

// parseAsync so errors thrown in async actions reach this catch.
program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
