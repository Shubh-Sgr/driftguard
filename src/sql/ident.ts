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

// Every keyword that Postgres itself quotes in quote_ident(): reserved, type/function-name and
// column-name keywords (pg_get_keywords() with catcode <> 'U'), the union of PostgreSQL 13 to 17.
// Left unquoted, a name like "case", "window" or "current_date" makes the generated SQL invalid.
const KEYWORDS = new Set([
  "all", "analyse", "analyze", "and", "any", "array", "as", "asc", "asymmetric",
  "authorization", "between", "bigint", "binary", "bit", "boolean", "both", "case", "cast",
  "char", "character", "check", "coalesce", "collate", "collation", "column", "concurrently",
  "constraint", "create", "cross", "current_catalog", "current_date", "current_role",
  "current_schema", "current_time", "current_timestamp", "current_user", "dec", "decimal",
  "default", "deferrable", "desc", "distinct", "do", "else", "end", "except", "exists",
  "extract", "false", "fetch", "float", "for", "foreign", "freeze", "from", "full", "grant",
  "greatest", "group", "grouping", "having", "ilike", "in", "initially", "inner", "inout",
  "int", "integer", "intersect", "interval", "into", "is", "isnull", "join", "json",
  "json_array", "json_arrayagg", "json_exists", "json_object", "json_objectagg", "json_query",
  "json_scalar", "json_serialize", "json_table", "json_value", "lateral", "leading", "least",
  "left", "like", "limit", "localtime", "localtimestamp", "merge_action", "national", "natural",
  "nchar", "none", "normalize", "not", "notnull", "null", "nullif", "numeric", "offset", "on",
  "only", "or", "order", "out", "outer", "overlaps", "overlay", "placing", "position",
  "precision", "primary", "real", "references", "returning", "right", "row", "select",
  "session_user", "setof", "similar", "smallint", "some", "substring", "symmetric",
  "system_user", "table", "tablesample", "then", "time", "timestamp", "to", "trailing", "treat",
  "trim", "true", "union", "unique", "user", "using", "values", "varchar", "variadic",
  "verbose", "when", "where", "window", "with", "xmlattributes", "xmlconcat", "xmlelement",
  "xmlexists", "xmlforest", "xmlnamespaces", "xmlparse", "xmlpi", "xmlroot", "xmlserialize",
  "xmltable",
]);

/**
 * Quotes an identifier only when needed, so generated SQL reads like hand-written SQL
 * (transactions, not "transactions") while names like "Order" or user stay correct.
 */
export function ident(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) && !KEYWORDS.has(name) ? name : quoteIdent(name);
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
