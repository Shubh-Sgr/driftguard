import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { createPool } from "../src/db.js";
import { introspect } from "../src/introspect/introspect.js";
import { OllamaProvider } from "../src/llm/ollama.js";
import { runLockAccuracy } from "./lib/lockAccuracy.js";
import { toMarkdown, summarize, type EvalResults } from "./lib/report.js";
import { runRewriteBench } from "./lib/rewriteBench.js";
import { runScenarios } from "./lib/scenarios.js";
import { SOURCE_RO_URL } from "./lib/scratch.js";

// F9: `npm run eval` — needs `npm run db:up`. Writes evals/results.md and results.json.
const here = path.dirname(fileURLToPath(import.meta.url));

const opts = new Command()
  .option("--only <parts...>", "scenarios, locks, rewrite", ["scenarios", "locks", "rewrite"])
  .option("--llm <model>", "also evaluate LLM plans with this Ollama model (e.g. llama3.2)")
  .option("--out <name>", "output file name (without extension)", "results")
  .parse()
  .opts<{ only: string[]; llm?: string; out: string }>();

const source = createPool(SOURCE_RO_URL, { statementTimeoutMs: 120_000 });
try {
  const sourceSchema = await introspect(source);
  const pgVersion = (await source.query("SHOW server_version")).rows[0].server_version as string;
  const llm = opts.llm ? new OllamaProvider(opts.llm) : undefined;

  const results: EvalResults = {
    runAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${os.platform()} ${os.arch()}`,
      cpu: `${os.cpus()[0]?.model ?? "unknown CPU"} x${os.cpus().length}`,
      postgres: pgVersion,
      llm: llm?.id ?? null,
    },
  };

  if (opts.only.includes("scenarios")) results.scenarios = await runScenarios(path.join(here, "scenarios"), source, sourceSchema, llm);
  if (opts.only.includes("locks")) results.locks = await runLockAccuracy(path.join(here, "locks/corpus.json"), path.join(here, "locks/prep.sql"));
  if (opts.only.includes("rewrite")) results.rewrite = await runRewriteBench();

  await writeFile(path.join(here, `${opts.out}.json`), `${JSON.stringify(results, null, 2)}\n`);
  await writeFile(path.join(here, `${opts.out}.md`), `${toMarkdown(results)}\n`);
  console.log(JSON.stringify(summarize(results), null, 2));
} finally {
  await source.end();
}
