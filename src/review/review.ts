import { analyzeMigration, type MigrationAnalysis } from "../locks/analyze.js";
import { maxRisk, type Risk } from "../locks/risk.js";
import { rewriteMigration, type RewriteResult } from "../rewrite/rewrite.js";

/**
 * `driftguard review`: offline lock analysis + safe-rewrite suggestions for migration
 * files, rendered as Markdown for a pull request comment or a CI job summary.
 * Offline means no database is contacted, so it is safe to run on untrusted PRs.
 */
export interface FileReview {
  path: string;
  analysis?: MigrationAnalysis;
  rewrite?: RewriteResult;
  /** Set when the file could not be analyzed (e.g. a syntax error). */
  error?: string;
}

/** First line of every comment we post, so the action can find and update it. */
export const REVIEW_MARKER = "<!-- driftguard-review -->";

// GitHub rejects comments over 65,536 characters; stay well below.
export const MAX_COMMENT_CHARS = 60_000;

export async function reviewFile(path: string, sql: string): Promise<FileReview> {
  try {
    return { path, analysis: await analyzeMigration(sql), rewrite: await rewriteMigration(sql) };
  } catch (err) {
    return { path, error: (err as Error).message };
  }
}

export function reviewMaxRisk(reviews: FileReview[]): Risk {
  return maxRisk(reviews.flatMap((r) => (r.analysis ? [r.analysis.maxRisk] : [])));
}

/**
 * Escapes text that came from the PR (file paths, identifiers inside notes, error
 * messages) so it can't add Markdown or HTML, break a table with "|", or @-mention
 * people. Numeric HTML entities render as the plain character on GitHub.
 */
export function escapeMd(text: string): string {
  // "[" and "]" cover links and images, so "(" and "!" can stay as they are.
  return text.replace(/\s+/g, " ").replace(/[&<>|@#`*_[\]~\\$]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * A fenced code block for untrusted text: the fence is one backtick longer than the
 * longest run of backticks inside, so the text can never close the block early.
 */
export function codeFence(text: string, lang = "sql"): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${lang}\n${text.replace(/\n+$/, "")}\n${fence}`;
}

export function reviewMarkdown(reviews: FileReview[], opts: { maxChars?: number } = {}): string {
  const maxChars = opts.maxChars ?? MAX_COMMENT_CHARS;
  const statements = reviews.reduce((n, r) => n + (r.analysis?.statements.length ?? 0), 0);
  const head = [
    REVIEW_MARKER,
    "## DriftGuard migration review",
    "",
    reviews.length
      ? `Highest lock risk: **${reviewMaxRisk(reviews).toUpperCase()}** across ${reviews.length} file(s), ${statements} statement(s).`
      : "No migration files changed.",
    "",
    "_Offline analysis: no database was contacted, so table sizes are unknown. For size-aware risk run `driftguard locks <file>`, and `driftguard preflight <file>` just before deploying._",
    "",
    "",
  ].join("\n");

  // Each file is one section; whole sections are dropped (never cut in half, which
  // could leave a code fence open) once the comment would get too long.
  const truncatedNote = (n: number) => `\n_…${n} more file(s) not shown: the comment would exceed GitHub's size limit. Run \`driftguard review\` locally for the full report._\n`;
  let body = head;
  const sections = reviews.map(fileSection);
  for (const [i, section] of sections.entries()) {
    if (body.length + section.length + truncatedNote(sections.length).length > maxChars) {
      body += truncatedNote(sections.length - i);
      break;
    }
    body += section;
  }
  return body;
}

function fileSection(r: FileReview): string {
  const lines = [`### ${escapeMd(r.path)}`, ""];
  if (r.error || !r.analysis) {
    lines.push(`Could not analyze this file: ${escapeMd(r.error ?? "unknown error")}`, "");
    return `${lines.join("\n")}\n`;
  }

  lines.push("| # | Operation | Lock | Blocks | Effects | Risk |", "|---|---|---|---|---|---|");
  for (const s of r.analysis.statements) {
    const lock = s.lockMode ? s.locks.map((l) => `${l.mode} on ${l.table}`).join(", ") : "none";
    const blocks = s.blocksReads ? "reads + writes" : s.blocksWrites ? "writes" : "—";
    const effects = [s.rewritesTable && "rewrites table", s.scansTable && "scans table", s.dataLoss && "DATA LOSS", !s.transactional && "no transaction"].filter(Boolean).join(", ") || "—";
    const risk = ["high", "critical"].includes(s.risk) ? `**${s.risk}**` : s.risk;
    lines.push(`| ${s.index + 1} | ${escapeMd(s.operation)} | ${escapeMd(lock)} | ${blocks} | ${effects} | ${risk} |`);
  }
  lines.push("");

  const notes = r.analysis.statements.flatMap((s) => [...s.reasons, ...s.notes].map((n) => `- ${s.index + 1}: ${escapeMd(n)}`));
  const warnings = r.analysis.warnings.map((w) => `- ⚠️ ${escapeMd(w)}`);
  if (notes.length || warnings.length) lines.push(...warnings, ...notes, "");

  if (r.rewrite?.statements.some((s) => s.rule)) {
    lines.push("<details><summary>Suggested safe rewrite</summary>", "", codeFence(r.rewrite.script), "", "</details>", "");
  }
  return `${lines.join("\n")}\n`;
}
