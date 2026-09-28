// Table and column names can't be sent as $1 parameters (parameters are values, not
// identifiers), so they go into SQL text. Every name we put in SQL comes from the
// database's own catalog (introspection), never from user or model input, and is
// still quoted here so odd names ("Order", "my-table") can't break or inject SQL.

/** Quotes an identifier the same way Postgres' quote_ident() does. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** "schema"."table" */
export function qualify(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

/** Quotes a string literal (for the rare places a value must be inlined, e.g. SET). */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// Common reserved words that must be quoted when used as a name.
const RESERVED = new Set([
  "all", "and", "any", "array", "as", "asc", "check", "collate", "column", "constraint", "create",
  "default", "desc", "distinct", "do", "else", "end", "false", "for", "foreign", "from", "grant",
  "group", "having", "in", "into", "is", "limit", "not", "null", "offset", "on", "or", "order",
  "primary", "references", "select", "table", "then", "to", "true", "union", "unique", "user",
  "using", "when", "where", "with",
]);

/**
 * Quotes an identifier only when needed, so generated SQL reads like hand-written SQL
 * (transactions, not "transactions") while names like "Order" or user stay correct.
 */
export function ident(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name) ? name : quoteIdent(name);
}

/** "public.transactions" -> transactions; other schemas stay qualified. */
export function tableRef(key: string): string {
  const dot = key.indexOf(".");
  const schema = key.slice(0, dot);
  const name = key.slice(dot + 1);
  return schema === "public" ? ident(name) : `${ident(schema)}.${ident(name)}`;
}

/** Postgres truncates identifiers to 63 bytes; do it ourselves so the name we print is the real one. */
export function constraintName(...parts: string[]): string {
  return parts.join("_").slice(0, 63);
}
