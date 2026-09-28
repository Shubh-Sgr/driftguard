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
