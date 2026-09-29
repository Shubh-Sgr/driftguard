import type pg from "pg";
import type { Config } from "./config.js";
import { redactUrl } from "./config.js";
import { createPool } from "./db.js";
import { diffSchemas } from "./diff/diff.js";
import type { DriftReport } from "./diff/types.js";
import { introspect } from "./introspect/introspect.js";
import type { Schema } from "./introspect/types.js";
import { GeminiProvider } from "./llm/gemini.js";
import { OllamaProvider } from "./llm/ollama.js";
import type { LlmProvider } from "./llm/provider.js";
import { analyzeMigration, type MigrationAnalysis } from "./locks/analyze.js";
import { evaluatePreflight, readLockActivity, type PreflightReport } from "./locks/preflight.js";
import { planMigration } from "./plan/plan.js";
import type { MigrationPlan } from "./plan/types.js";
import { createReceipt, type SignedReceipt } from "./receipt/receipt.js";
import { rewriteMigration, type RewriteResult } from "./rewrite/rewrite.js";
import { shadowRun, type ShadowReport } from "./shadow/shadow.js";
import { shadowVerifier } from "./shadow/verifier.js";
import { findDifferingRowsInTable, verifyData, type TableVerification, type VerifyOptions, type VerifyReport } from "./verify/verify.js";

/**
 * The one place that wires features to databases. The CLI and the MCP server both
 * call these methods, so they can never behave differently.
 * Both pools are read-only (see db.ts); nothing here writes to source or target.
 */
export class DriftGuard {
  readonly source: pg.Pool;
  readonly target: pg.Pool;

  constructor(private readonly config: Config) {
    this.source = createPool(config.sourceUrl, { statementTimeoutMs: config.statementTimeoutMs });
    this.target = createPool(config.targetUrl, { statementTimeoutMs: config.statementTimeoutMs });
  }

  async close(): Promise<void> {
    await Promise.all([this.source.end(), this.target.end()]);
  }

  async schemas(schemaNames?: string[]): Promise<{ source: Schema; target: Schema }> {
    const [source, target] = await Promise.all([introspect(this.source, schemaNames), introspect(this.target, schemaNames)]);
    return { source, target };
  }

  /** F1 + F2 */
  async detectDrift(schemaNames?: string[]): Promise<DriftReport> {
    const { source, target } = await this.schemas(schemaNames);
    return diffSchemas(source, target);
  }

  /** F3 (+ F4 when findRows is set) */
  verifyData(opts: VerifyOptions = {}): Promise<VerifyReport> {
    return verifyData(this.source, this.target, opts);
  }

  /** F4 for one table */
  findDifferingRows(table: string, opts: { chunkSize?: number; maxRows?: number } = {}): Promise<TableVerification> {
    return findDifferingRowsInTable(this.source, this.target, table, opts);
  }

  /** F5: sizes come from the TARGET, the database the migration will run on. */
  async analyzeLocks(sql: string): Promise<MigrationAnalysis> {
    return analyzeMigration(sql, await introspect(this.target));
  }

  /**
   * Is it safe to run this migration RIGHT NOW? Compares the locks it needs (F5) with
   * the locks and open transactions on the target at this moment. Only reads catalogs.
   */
  async preflight(sql: string): Promise<PreflightReport> {
    const analysis = await this.analyzeLocks(sql);
    const tables = [...new Set(analysis.statements.flatMap((s) => s.locks.map((l) => l.table)))];
    return evaluatePreflight(analysis, await readLockActivity(this.target, tables));
  }

  /** F6 */
  async suggestSafeRewrite(sql: string): Promise<RewriteResult> {
    return rewriteMigration(sql, { schema: await introspect(this.target) });
  }

  /**
   * F7: useLlm=false forces a rules-only plan. With an LLM, a plan is accepted only
   * after the validator AND a shadow run (F10) pass, unless DRIFTGUARD_SHADOW_VERIFY=off.
   */
  async plan(opts: { useLlm?: boolean } = {}): Promise<{ drift: DriftReport; plan: MigrationPlan }> {
    const { source, target } = await this.schemas();
    const drift = diffSchemas(source, target);
    const llm = opts.useLlm === false ? undefined : this.llmProvider();
    const verify = llm && this.config.shadowVerify ? shadowVerifier({ targetUrl: this.config.targetUrl, source }) : undefined;
    return { drift, plan: await planMigration({ drift, source, target, llm, verify }) };
  }

  /** F10: plan, then prove it on a disposable copy of the target's schema. */
  async shadow(opts: { useLlm?: boolean; allowDataLoss?: boolean } = {}): Promise<{ drift: DriftReport; plan: MigrationPlan; shadow: ShadowReport }> {
    const source = await introspect(this.source);
    const { drift, plan } = await this.plan(opts);
    const shadow = await shadowRun({ targetUrl: this.config.targetUrl, source, plan, allowDataLoss: opts.allowDataLoss });
    return { drift, plan, shadow };
  }

  /** F12 */
  receipt(results: Record<string, unknown>): SignedReceipt {
    return createReceipt({ source: redactUrl(this.config.sourceUrl), target: redactUrl(this.config.targetUrl) }, results);
  }

  llmProvider(): LlmProvider | undefined {
    const { llm } = this.config;
    if (llm.provider === "ollama") return new OllamaProvider(llm.ollamaModel, llm.ollamaUrl);
    if (llm.provider === "gemini") {
      if (!llm.geminiApiKey) throw new Error("DRIFTGUARD_LLM=gemini needs GEMINI_API_KEY");
      return new GeminiProvider(llm.geminiApiKey, llm.geminiModel);
    }
    return undefined;
  }
}
