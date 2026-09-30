import { parse, scan } from "libpg-query";

// libpg-query is PostgreSQL's own parser (compiled to WebAssembly), so we get exactly
// the syntax tree Postgres itself would build — no regex guessing about what a
// statement does. The AST is untyped JSON, so `any` is used at this boundary only.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type AstNode = any;

export interface ParsedStatement {
  index: number;
  /** Node type, e.g. "IndexStmt", "AlterTableStmt". */
  type: string;
  /** The node body, e.g. the contents of { IndexStmt: {...} }. */
  node: AstNode;
  /** The statement's original SQL text (trimmed, no trailing semicolon). */
  text: string;
  /** Byte offsets of the statement in the original input (end is exclusive). */
  start: number;
  end: number;
  /** The whole input as UTF-8 bytes; AST `location` fields are byte offsets into it. */
  bytes: Buffer;
}

/** Parses a SQL script into statements. Throws with Postgres' own message on a syntax error. */
export async function parseSql(sql: string): Promise<ParsedStatement[]> {
  const tree = await parse(sql);
  const bytes = Buffer.from(sql, "utf8");
  return (tree.stmts ?? []).map((raw: AstNode, index: number) => {
    const start: number = raw.stmt_location ?? 0;
    // stmt_len is 0/absent for the last statement when it has no trailing semicolon.
    const end = raw.stmt_len ? start + raw.stmt_len : bytes.length;
    const [type, node] = Object.entries(raw.stmt)[0] as [string, AstNode];
    return {
      index,
      type,
      node,
      text: stripLeadingComments(bytes.subarray(start, end).toString("utf8")),
      start,
      end,
      bytes,
    };
  });
}

export interface SqlToken {
  /** Byte offsets into the UTF-8 input (end is exclusive). */
  start: number;
  end: number;
  text: string;
  /** The name if this token is an identifier (quotes removed, case-folded like Postgres), else null. */
  ident: string | null;
}

/**
 * Splits SQL into tokens with Postgres' own scanner. Used to rename one identifier in a
 * catalog definition without touching string literals, comments or other names.
 */
export async function scanSql(sql: string): Promise<SqlToken[]> {
  const { tokens } = await scan(sql);
  return tokens.map((t: AstNode) => ({
    start: t.start,
    end: t.end,
    text: t.text,
    // Unreserved keywords (name, type, action, ...) are valid unquoted identifiers.
    ident: t.tokenName === "IDENT" || t.keywordName === "UNRESERVED_KEYWORD"
      ? (t.text.startsWith('"') ? t.text.slice(1, -1).replace(/""/g, '"') : t.text.toLowerCase())
      : null,
  }));
}

/** Text between two byte offsets of the original input (AST locations are bytes, not chars). */
export function sliceBytes(stmt: ParsedStatement, from: number, to: number = stmt.end): string {
  return stmt.bytes.subarray(from, to).toString("utf8").trim();
}

function stripLeadingComments(text: string): string {
  // Statement text starts right after the previous ';', so it can include comment lines.
  return text.replace(/^(\s*--[^\n]*\n)*/, "").trim();
}

/** "schema.table" for a RangeVar node; unqualified names are assumed to be in public. */
export function rangeVarName(rv: AstNode): string {
  return `${rv.schemaname ?? "public"}.${rv.relname}`;
}

/** Reads the string out of a { String: { sval } } node list, e.g. column lists. */
export function stringList(nodes: AstNode[] | undefined): string[] {
  return (nodes ?? []).map((n) => n.String?.sval).filter((s): s is string => typeof s === "string");
}
