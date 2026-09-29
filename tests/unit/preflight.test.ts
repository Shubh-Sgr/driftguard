import { describe, expect, it } from "vitest";
import { analyzeMigration } from "../../src/locks/analyze.js";
import { conflicts, fromPgLockMode, LOCK_MODES, type LockMode } from "../../src/locks/modes.js";
import { evaluatePreflight, type LockActivity, type SessionInfo } from "../../src/locks/preflight.js";

const session = (pid: number | null, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  pid,
  user: "app",
  applicationName: "api",
  state: "active",
  transactionAgeSeconds: 5,
  stateAgeSeconds: 1,
  ...extra,
});

const activity = (partial: Partial<LockActivity>): LockActivity => ({ visibility: "full", relationLocks: [], openTransactions: [], ...partial });

describe("lock conflict matrix", () => {
  it("matches the Postgres docs for the cases migrations care about", () => {
    const yes: [LockMode, LockMode][] = [
      ["ACCESS EXCLUSIVE", "ACCESS SHARE"], // ALTER TABLE vs a plain SELECT
      ["SHARE", "ROW EXCLUSIVE"], // CREATE INDEX vs INSERT/UPDATE
      ["SHARE UPDATE EXCLUSIVE", "SHARE UPDATE EXCLUSIVE"], // two CONCURRENTLY builds, or one vs VACUUM
      ["EXCLUSIVE", "ROW SHARE"],
    ];
    const no: [LockMode, LockMode][] = [
      ["ROW EXCLUSIVE", "ROW EXCLUSIVE"], // concurrent writes don't conflict at table level
      ["SHARE", "SHARE"], // two plain CREATE INDEX builds can run together
      ["SHARE UPDATE EXCLUSIVE", "ROW EXCLUSIVE"], // CREATE INDEX CONCURRENTLY allows writes
      ["ACCESS SHARE", "EXCLUSIVE"],
    ];
    for (const [a, b] of yes) expect(conflicts(a, b), `${a} vs ${b}`).toBe(true);
    for (const [a, b] of no) expect(conflicts(a, b), `${a} vs ${b}`).toBe(false);
  });

  it("is symmetric and has the docs' 38 conflicting pairs", () => {
    let count = 0;
    for (const a of LOCK_MODES) {
      for (const b of LOCK_MODES) {
        expect(conflicts(a, b)).toBe(conflicts(b, a));
        if (conflicts(a, b)) count++;
      }
    }
    expect(count).toBe(38);
  });

  it("maps pg_locks mode names", () => {
    const pgNames = ["AccessShareLock", "RowShareLock", "RowExclusiveLock", "ShareUpdateExclusiveLock", "ShareLock", "ShareRowExclusiveLock", "ExclusiveLock", "AccessExclusiveLock"];
    expect(pgNames.map(fromPgLockMode)).toEqual([...LOCK_MODES]);
    expect(fromPgLockMode("SIReadLock")).toBeNull(); // predicate locks aren't table locks
  });
});

describe("evaluatePreflight", () => {
  it("ALTER TABLE would wait behind an idle-in-transaction reader; a SELECT would not", async () => {
    const idle = session(42, { state: "idle in transaction", transactionAgeSeconds: 900 });
    const now = activity({ relationLocks: [{ table: "public.accounts", mode: "ACCESS SHARE", granted: true, session: idle }], openTransactions: [idle] });

    const alter = evaluatePreflight(await analyzeMigration("ALTER TABLE accounts ADD COLUMN x int"), now);
    expect(alter).toMatchObject({ verdict: "would_wait", blockingSessions: 1, oldestBlockingTransactionSeconds: 900 });
    expect(alter.statements[0]!.waitsFor[0]!.reason).toMatch(/holds ACCESS SHARE on public.accounts, which conflicts with the ACCESS EXCLUSIVE/);
    expect(alter.longTransactions.map((s) => s.pid)).toEqual([42]);
    expect(alter.notes.join(" ")).toMatch(/lock_timeout/);

    const select = evaluatePreflight(await analyzeMigration("SELECT * FROM accounts"), now);
    expect(select).toMatchObject({ verdict: "safe_now", blockingSessions: 0 });
  });

  it("queues behind a session that is itself waiting for a conflicting lock", async () => {
    // pid 7 waits for ACCESS EXCLUSIVE (e.g. someone else's ALTER). Even a plain UPDATE
    // (ROW EXCLUSIVE) now lines up behind it: the classic lock-queue outage.
    const now = activity({ relationLocks: [{ table: "public.accounts", mode: "ACCESS EXCLUSIVE", granted: false, session: session(7) }] });
    const r = evaluatePreflight(await analyzeMigration("UPDATE accounts SET status = 'x' WHERE id = 1"), now);
    expect(r.verdict).toBe("would_wait");
    expect(r.statements[0]!.waitsFor[0]!.reason).toMatch(/already waiting for ACCESS EXCLUSIVE/);
  });

  it("CREATE INDEX CONCURRENTLY waits for open transactions even on other tables", async () => {
    const other = session(9, { state: "idle in transaction" });
    const r = evaluatePreflight(await analyzeMigration("CREATE INDEX CONCURRENTLY i ON accounts (status)"), activity({ openTransactions: [other] }));
    expect(r.verdict).toBe("would_wait");
    expect(r.statements[0]!.waitsFor[0]!.reason).toMatch(/waits for every older transaction/);

    // A plain CREATE INDEX only cares about locks on its own table.
    const plain = evaluatePreflight(await analyzeMigration("CREATE INDEX i ON accounts (status)"), activity({ openTransactions: [other] }));
    expect(plain.verdict).toBe("safe_now");
  });

  it("does not treat compatible locks as blockers", async () => {
    const writer = session(3);
    const now = activity({ relationLocks: [{ table: "public.accounts", mode: "ROW EXCLUSIVE", granted: true, session: writer }] });
    // CREATE INDEX CONCURRENTLY (SHARE UPDATE EXCLUSIVE) allows concurrent writes.
    expect(evaluatePreflight(await analyzeMigration("CREATE INDEX CONCURRENTLY i ON accounts (status)"), now).verdict).toBe("safe_now");
    // A plain CREATE INDEX (SHARE) does not.
    expect(evaluatePreflight(await analyzeMigration("CREATE INDEX i ON accounts (status)"), now).verdict).toBe("would_wait");
  });

  it("counts a session once even if it blocks several statements, and reports limited visibility", async () => {
    const s = session(5, { state: null, transactionAgeSeconds: null, stateAgeSeconds: null });
    const now = activity({
      visibility: "limited",
      relationLocks: [
        { table: "public.accounts", mode: "ROW EXCLUSIVE", granted: true, session: s },
        { table: "public.customers", mode: "ROW EXCLUSIVE", granted: true, session: s },
      ],
    });
    const r = evaluatePreflight(await analyzeMigration("ALTER TABLE accounts ADD COLUMN a int; ALTER TABLE customers ADD COLUMN b int"), now);
    expect(r.statements.map((x) => x.verdict)).toEqual(["would_wait", "would_wait"]);
    expect(r).toMatchObject({ blockingSessions: 1, oldestBlockingTransactionSeconds: null, visibility: "limited" });
    expect(r.notes[0]).toMatch(/Limited visibility/);
  });

  it("statements without a table lock are safe now", async () => {
    const r = evaluatePreflight(await analyzeMigration("SET lock_timeout = '3s'"), activity({}));
    expect(r).toMatchObject({ verdict: "safe_now", statements: [{ locks: [], verdict: "safe_now" }] });
  });
});
