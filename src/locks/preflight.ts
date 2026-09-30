import type pg from "pg";
import type { MigrationAnalysis } from "./analyze.js";
import { blocksReads, blocksWrites, conflicts, fromPgLockMode, type LockMode } from "./modes.js";

/**
 * Another database session, described without its query text: queries can contain
 * personal data, and PgVouch never needs them to decide anything.
 */
export interface SessionInfo {
  /** null for a prepared transaction (PREPARE TRANSACTION), which has no backend. */
  pid: number | null;
  user: string | null;
  applicationName: string | null;
  /** e.g. "active", "idle in transaction"; null without pg_read_all_stats. */
  state: string | null;
  transactionAgeSeconds: number | null;
  /** How long the session has been in its current state (e.g. idle in transaction). */
  stateAgeSeconds: number | null;
}

export interface RelationLock {
  table: string;
  mode: LockMode;
  /** false = the session is itself still waiting in the lock queue. */
  granted: boolean;
  session: SessionInfo;
}

/** What the target looks like right now: table locks and open transactions. */
export interface LockActivity {
  /** "limited" = no pg_read_all_stats: locks are visible, but not states or ages. */
  visibility: "full" | "limited";
  relationLocks: RelationLock[];
  /** Sessions in this database with an open transaction (CONCURRENTLY waits for these). */
  openTransactions: SessionInfo[];
}

export interface Blocker {
  session: SessionInfo;
  reason: string;
}

export interface StatementPreflight {
  index: number;
  operation: string;
  locks: { table: string; mode: LockMode }[];
  verdict: "safe_now" | "would_wait";
  waitsFor: Blocker[];
}

export interface PreflightReport {
  verdict: "safe_now" | "would_wait";
  visibility: LockActivity["visibility"];
  statements: StatementPreflight[];
  /** Distinct sessions the migration would wait behind. */
  blockingSessions: number;
  oldestBlockingTransactionSeconds: number | null;
  /** Open transactions older than LONG_TRANSACTION_SECONDS, or idle in transaction. */
  longTransactions: SessionInfo[];
  notes: string[];
}

export const LONG_TRANSACTION_SECONDS = 60;

// Statements that wait for every transaction in the database that is older than them
// (Postgres' WaitForOlderSnapshots), not just for conflicting table locks.
const WAITS_FOR_OLDER_TRANSACTIONS = new Set(["CREATE INDEX CONCURRENTLY", "REINDEX CONCURRENTLY"]);

// Ages as float8 so node-postgres returns numbers, not strings (numeric in PG 14+).
const SESSION_COLUMNS = `
  a.usename AS user, a.application_name, a.state,
  extract(epoch FROM now() - a.xact_start)::float8   AS xact_age,
  extract(epoch FROM now() - a.state_change)::float8 AS state_age`;

/**
 * Reads the current locks on `tables` and the open transactions in the target
 * database. Two read-only catalog queries; our own session is excluded.
 */
export async function readLockActivity(pool: pg.Pool, tables: string[]): Promise<LockActivity> {
  const client = await pool.connect();
  try {
    const visibility = await client.query<{ full: boolean }>(`SELECT pg_has_role('pg_read_all_stats', 'USAGE') AS full`);

    // IS DISTINCT FROM (not <>) so prepared transactions, whose pid is NULL, are kept.
    const locks = await client.query(
      `SELECT l.pid, l.mode, l.granted, n.nspname || '.' || c.relname AS table_key, ${SESSION_COLUMNS}
       FROM pg_locks l
       JOIN pg_class c ON c.oid = l.relation
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE l.locktype = 'relation'
         AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
         AND l.pid IS DISTINCT FROM pg_backend_pid()
         AND n.nspname || '.' || c.relname = ANY($1::text[])`,
      [tables],
    );

    // Every transaction holds a lock on its own virtual transaction id, and pg_locks is
    // readable without extra privileges, so this finds open transactions even with
    // limited visibility. Autovacuum is skipped: CONCURRENTLY doesn't wait for it.
    const open = await client.query(
      `SELECT DISTINCT l.pid, ${SESSION_COLUMNS}
       FROM pg_locks l
       JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE l.locktype = 'virtualxid' AND l.granted
         AND l.pid <> pg_backend_pid()
         AND a.datname = current_database()
         AND a.backend_type IS DISTINCT FROM 'autovacuum worker'`,
    );

    return {
      visibility: visibility.rows[0]!.full ? "full" : "limited",
      relationLocks: locks.rows.flatMap((r) => {
        const mode = fromPgLockMode(r.mode);
        return mode ? [{ table: r.table_key, mode, granted: r.granted, session: toSession(r) }] : [];
      }),
      openTransactions: open.rows.map(toSession),
    };
  } finally {
    client.release();
  }
}

function toSession(r: Record<string, unknown>): SessionInfo {
  const age = (v: unknown) => (typeof v === "number" ? Math.round(v * 10) / 10 : null);
  return {
    pid: (r.pid as number | null) ?? null,
    user: (r.user as string | null) ?? null,
    applicationName: (r.application_name as string | null) || null,
    state: r.pid === null ? "prepared transaction" : ((r.state as string | null) ?? null),
    transactionAgeSeconds: age(r.xact_age),
    stateAgeSeconds: age(r.state_age),
  };
}

/**
 * Pure decision: for each statement, which current sessions would it queue behind?
 *  - a session holding a conflicting lock on the same table;
 *  - a session already WAITING for a conflicting lock (the queue is first come, first
 *    served, so we'd line up behind it);
 *  - for CREATE INDEX / REINDEX CONCURRENTLY, every other open transaction.
 */
export function evaluatePreflight(analysis: MigrationAnalysis, activity: LockActivity): PreflightReport {
  const statements: StatementPreflight[] = analysis.statements.map((s) => {
    const waitsFor = new Map<string, Blocker>(); // one entry per session
    const add = (session: SessionInfo, reason: string) => {
      const key = String(session.pid);
      if (!waitsFor.has(key)) waitsFor.set(key, { session, reason });
    };

    for (const need of s.locks) {
      for (const held of activity.relationLocks) {
        if (held.table !== need.table || !conflicts(need.mode, held.mode)) continue;
        add(held.session, held.granted
          ? `holds ${held.mode} on ${held.table}, which conflicts with the ${need.mode} this statement needs`
          : `is already waiting for ${held.mode} on ${held.table}; this statement would queue behind it`);
      }
    }
    if (WAITS_FOR_OLDER_TRANSACTIONS.has(s.operation)) {
      for (const session of activity.openTransactions) {
        add(session, `has an open transaction; ${s.operation} waits for every older transaction in the database to finish`);
      }
    }
    return {
      index: s.index,
      operation: s.operation,
      locks: s.locks,
      verdict: waitsFor.size ? "would_wait" : "safe_now",
      waitsFor: [...waitsFor.values()],
    };
  });

  const blockers = new Map<string, SessionInfo>();
  for (const s of statements) for (const b of s.waitsFor) blockers.set(String(b.session.pid), b.session);
  const ages = [...blockers.values()].map((b) => b.transactionAgeSeconds).filter((a): a is number => a !== null);

  const sessions = new Map<string, SessionInfo>();
  for (const l of activity.relationLocks) sessions.set(String(l.session.pid), l.session);
  for (const t of activity.openTransactions) sessions.set(String(t.pid), t);
  const longTransactions = [...sessions.values()].filter(
    (s) => s.state === "idle in transaction" || s.state === "idle in transaction (aborted)" || (s.transactionAgeSeconds ?? 0) > LONG_TRANSACTION_SECONDS,
  );

  const notes: string[] = [];
  if (activity.visibility === "limited") {
    notes.push("Limited visibility: this role lacks pg_read_all_stats, so session states and transaction ages are unknown. Lock conflicts are still detected (pg_locks is readable by everyone). Open transactions are found from pg_locks, too.");
  }
  const waiting = statements.filter((s) => s.verdict === "would_wait");
  if (waiting.some((s) => s.locks.some((l) => blocksWrites(l.mode) || blocksReads(l.mode)))) {
    notes.push("While a statement waits for its lock, new queries that conflict with it queue BEHIND it: a blocked ALTER TABLE can stall all traffic on the table. Run the migration with SET lock_timeout so it gives up instead, and retry later.");
  }
  if (longTransactions.length) {
    notes.push(`${longTransactions.length} long or idle-in-transaction session(s) found. PgVouch never terminates sessions; ask their owner, or use pg_terminate_backend yourself if appropriate.`);
  }
  notes.push("This is a snapshot: sessions can start or finish a moment later.");

  return {
    verdict: waiting.length ? "would_wait" : "safe_now",
    visibility: activity.visibility,
    statements,
    blockingSessions: blockers.size,
    oldestBlockingTransactionSeconds: ages.length ? Math.max(...ages) : null,
    longTransactions,
    notes,
  };
}
