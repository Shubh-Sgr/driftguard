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

// The full conflict table ("Conflicting Lock Modes" in the docs above): which modes
// can't be held on the same table at the same time. It is symmetric.
const CONFLICTS: Record<LockMode, readonly LockMode[]> = {
  "ACCESS SHARE": ["ACCESS EXCLUSIVE"],
  "ROW SHARE": ["EXCLUSIVE", "ACCESS EXCLUSIVE"],
  "ROW EXCLUSIVE": ["SHARE", "SHARE ROW EXCLUSIVE", "EXCLUSIVE", "ACCESS EXCLUSIVE"],
  "SHARE UPDATE EXCLUSIVE": ["SHARE UPDATE EXCLUSIVE", "SHARE", "SHARE ROW EXCLUSIVE", "EXCLUSIVE", "ACCESS EXCLUSIVE"],
  "SHARE": ["ROW EXCLUSIVE", "SHARE UPDATE EXCLUSIVE", "SHARE ROW EXCLUSIVE", "EXCLUSIVE", "ACCESS EXCLUSIVE"],
  "SHARE ROW EXCLUSIVE": ["ROW EXCLUSIVE", "SHARE UPDATE EXCLUSIVE", "SHARE", "SHARE ROW EXCLUSIVE", "EXCLUSIVE", "ACCESS EXCLUSIVE"],
  "EXCLUSIVE": ["ROW SHARE", "ROW EXCLUSIVE", "SHARE UPDATE EXCLUSIVE", "SHARE", "SHARE ROW EXCLUSIVE", "EXCLUSIVE", "ACCESS EXCLUSIVE"],
  "ACCESS EXCLUSIVE": LOCK_MODES,
};

export const conflicts = (a: LockMode, b: LockMode): boolean => CONFLICTS[a].includes(b);

/** pg_locks.mode uses CamelCase names ("RowExclusiveLock"); map them to the docs' names. */
export function fromPgLockMode(name: string): LockMode | null {
  const words = name.replace(/Lock$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase();
  return (LOCK_MODES as readonly string[]).includes(words) ? (words as LockMode) : null;
}
