import type { DriftItem, DriftReport } from "../diff/types.js";
import type { MigrationAnalysis } from "../locks/analyze.js";
import type { ShadowReport } from "../shadow/shadow.js";
import type { VerifyReport } from "../verify/verify.js";

// Human-readable output for the terminal. Every command also has --json.

export function formatDrift(report: DriftReport): string {
  if (report.identical) return "No schema drift: source and target match.";
  const { high, medium, low } = report.summary;
  const lines = [`Schema drift: ${report.items.length} item(s) — ${high} high, ${medium} medium, ${low} low`, ""];
  for (const item of report.items) lines.push(`  [${item.severity.padEnd(6)}] ${describeDrift(item)}`);
  return lines.join("\n");
}

export function describeDrift(i: DriftItem): string {
  switch (i.kind) {
    case "table_missing": return `table ${i.table} is missing on target`;
    case "table_extra": return `table ${i.table} exists only on target`;
    case "column_missing": return `column ${i.table}.${i.column} (${i.type}) is missing on target`;
    case "column_extra": return `column ${i.table}.${i.column} (${i.type}) exists only on target`;
    case "column_type_changed": return `column ${i.table}.${i.column}: ${i.from} -> ${i.to}`;
    case "column_nullability_changed": return `column ${i.table}.${i.column}: ${i.from ? "NULL" : "NOT NULL"} -> ${i.to ? "NULL" : "NOT NULL"}`;
    case "column_default_changed": return `column ${i.table}.${i.column} default: ${i.from ?? "none"} -> ${i.to ?? "none"}`;
    case "primary_key_changed": return `primary key of ${i.table}: (${i.from?.join(", ") ?? "none"}) -> (${i.to?.join(", ") ?? "none"})`;
    case "index_missing": return `index ${i.name} on ${i.table} is missing on target`;
    case "index_extra": return `index ${i.name} on ${i.table} exists only on target`;
    case "index_changed": return `index ${i.name} on ${i.table} differs:\n             source: ${i.from}\n             target: ${i.to}`;
    case "constraint_missing": return `constraint ${i.name} on ${i.table} is missing on target: ${i.definition}`;
    case "constraint_extra": return `constraint ${i.name} on ${i.table} exists only on target: ${i.definition}`;
    case "constraint_changed": return `constraint ${i.name} on ${i.table} differs:\n             source: ${i.from}\n             target: ${i.to}`;
    case "sequence_missing": return `sequence ${i.sequence} is missing on target`;
    case "sequence_extra": return `sequence ${i.sequence} exists only on target`;
    case "sequence_changed": return `sequence ${i.sequence} ${i.field}: ${i.from} -> ${i.to}`;
    case "possible_rename": return `(hint) ${i.table}.${i.from} -> ${i.to} might be a rename; review before dropping anything`;
  }
}

export function formatVerify(report: VerifyReport): string {
  const lines = [`Data verification: ${report.identical ? "IDENTICAL" : "DIFFERENCES FOUND"} (${(report.elapsedMs / 1000).toFixed(1)}s)`, ""];
  for (const t of report.tables) {
    const rows = `${t.sourceRows.toLocaleString("en-US")} / ${t.targetRows.toLocaleString("en-US")} rows`;
    lines.push(`  ${t.status.toUpperCase().padEnd(8)} ${t.table.padEnd(28)} ${t.status === "skipped" ? "" : `${rows}, ${t.chunks} chunk(s)`}`);
    if (t.reason) lines.push(`           ${t.reason}`);
    for (const c of t.mismatchedChunks.slice(0, 5)) lines.push(`           mismatched chunk ${c.description}: ${c.source.rows} vs ${c.target.rows} rows`);
    if (t.mismatchedChunks.length > 5) lines.push(`           ... and ${t.mismatchedChunks.length - 5} more chunk(s)`);
    if (t.differingRows) {
      for (const r of t.differingRows.slice(0, 20)) {
        const key = Object.entries(r.key).map(([k, v]) => `${k}=${v}`).join(", ");
        lines.push(`           ${r.kind.padEnd(18)} ${key}${r.kind === "changed" ? `  columns: ${r.columns.join(", ")}` : ""}`);
      }
      if (t.differingRows.length > 20) lines.push(`           ... ${t.differingRows.length - 20} more row(s) (use --json)`);
      if (t.bisect) {
        lines.push(`           bisection: ${t.bisect.hashQueries} hash round(s), ${t.bisect.rowsFetched} row(s) fetched, depth ${t.bisect.maxDepth}${t.bisect.truncated ? " (truncated: widespread mismatch)" : ""}`);
      }
    }
  }
  return lines.join("\n");
}

export function formatLocks(a: MigrationAnalysis): string {
  const lines = [`Lock analysis: highest risk = ${a.maxRisk.toUpperCase()}`, ""];
  for (const s of a.statements) {
    lines.push(`  ${String(s.index + 1).padStart(2)}. [${s.risk.padEnd(8)}] ${s.operation}`);
    lines.push(`      ${s.sql.replace(/\s+/g, " ").slice(0, 110)}`);
    if (s.lockMode) {
      const blocks = s.blocksReads ? "reads + writes" : s.blocksWrites ? "writes" : "nothing normal";
      lines.push(`      lock: ${s.lockMode} on ${s.locks.map((l) => l.table).join(", ")} — blocks ${blocks}`);
    }
    const effects = [s.rewritesTable && "rewrites table", s.scansTable && "scans table", s.dataLoss && "DATA LOSS", !s.transactional && "cannot run in a transaction"].filter(Boolean);
    if (effects.length) lines.push(`      effects: ${effects.join(", ")}`);
    for (const r of [...s.reasons, ...s.notes]) lines.push(`      - ${r}`);
  }
  if (a.warnings.length) lines.push("", "Warnings:", ...a.warnings.map((w) => `  ! ${w}`));
  return lines.join("\n");
}

export function formatShadow(r: ShadowReport): string {
  const lines = [`Shadow run: ${r.verdict.toUpperCase()} (${(r.elapsedMs / 1000).toFixed(1)}s, disposable container, schema only)`, ""];
  for (const s of r.steps) lines.push(`  ${String(s.step).padStart(2)}. ${s.status.padEnd(8)} ${s.title}${s.reason ? `  (${s.reason})` : ""}`);
  const unexpected = r.remainingDrift.items.filter((i) => !r.expectedRemaining.includes(i));
  lines.push("", unexpected.length ? "Drift still present after applying the plan:" : "After the plan, the shadow matches the source schema.");
  for (const i of unexpected) lines.push(`  - ${describeDrift(i)}`);
  if (r.expectedRemaining.length) lines.push(`  (${r.expectedRemaining.length} item(s) intentionally left for the contract phase / manual steps)`);
  return lines.join("\n");
}
