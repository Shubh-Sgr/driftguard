// PostgreSQL's eight table-level lock modes, weakest to strongest.
// Source: https://www.postgresql.org/docs/current/explicit-locking.html
export const LOCK_MODES = [
  "ACCESS SHARE", // SELECT
  "ROW SHARE", // SELECT ... FOR UPDATE
  "ROW EXCLUSIVE", // INSERT / UPDATE / DELETE
  "SHARE UPDATE EXCLUSIVE", // VACUUM, CREATE INDEX CONCURRENTLY, VALIDATE CONSTRAINT
  "SHARE", // CREATE INDEX
  "SHARE ROW EXCLUSIVE", // ADD FOREIGN KEY, CREATE TRIGGER
  "EXCLUSIVE", // REFRESH MATERIALIZED VIEW CONCURRENTLY
  "ACCESS EXCLUSIVE", // most ALTER TABLE, DROP, TRUNCATE, VACUUM FULL
] as const;

export type LockMode = (typeof LOCK_MODES)[number];

export const lockStrength = (mode: LockMode) => LOCK_MODES.indexOf(mode);

export function strongest(modes: LockMode[]): LockMode {
  return modes.reduce((a, b) => (lockStrength(b) > lockStrength(a) ? b : a), "ACCESS SHARE" as LockMode);
}

// From the conflict table in the docs, we only need two questions:
// does this lock make ordinary reads (ACCESS SHARE) wait? Ordinary writes (ROW EXCLUSIVE)?
export const blocksReads = (mode: LockMode) => mode === "ACCESS EXCLUSIVE";
export const blocksWrites = (mode: LockMode) => lockStrength(mode) >= lockStrength("SHARE");
