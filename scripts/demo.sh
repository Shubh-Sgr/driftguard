#!/usr/bin/env bash
# Guided PgVouch demo: break the target database on purpose, watch every feature
# find and fix the problem, then put the target back. Needs `npm run db:up` first.
# The "damage" is done with the superuser inside the container, playing "someone else";
# PgVouch itself only ever connects read-only.
set -euo pipefail
cd "$(dirname "$0")/.."

cli() { npx tsx --env-file=.env src/cli/index.ts "$@"; }
target_sql() { docker exec -i pgvouch-target-db-1 psql -q -U postgres -d fintech "$@"; }
step() {
  printf '\n\033[1;36m━━ %s ━━\033[0m\n' "$1"
  [ -n "${2:-}" ] && printf '\033[2m%s\033[0m\n' "$2"
  sleep "${DEMO_PAUSE:-3}"
}
run() { printf '\033[1;33m$ pgvouch %s\033[0m\n' "$*"; cli "$@" || true; }

restore() {
  step "Cleanup" "Putting the target back exactly as it was."
  docker exec pgvouch-source-db-1 psql -U postgres -d fintech -Atc \
    "COPY (SELECT * FROM ledger_entries WHERE id IN (777001, 777002)) TO STDOUT" |
    target_sql -c "COPY ledger_entries FROM STDIN" 2>/dev/null || true
  target_sql -c "UPDATE transactions SET amount = amount - 1 WHERE id = 424242" \
    -c "CREATE INDEX IF NOT EXISTS transactions_account_created_idx ON transactions (account_id, created_at)" \
    -c "ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES transactions (id)" \
    -c "ALTER TABLE accounts ALTER COLUMN status SET NOT NULL" \
    -c "ALTER TABLE customers DROP COLUMN IF EXISTS legacy_code"
  run diff
}

step "0. Safety check" "Both connections must be read-only before PgVouch does anything."
run doctor

step "1. Baseline" "Source and target start identical: same schema, same 3.1M rows."
run diff
run verify --table transactions ledger_entries

step "2. Something goes wrong on the target" "A manual hotfix changes the schema; a bad copy loses 2 rows and corrupts 1 amount."
target_sql <<'SQL'
DROP INDEX transactions_account_created_idx;
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_transaction_id_fkey;
ALTER TABLE accounts ALTER COLUMN status DROP NOT NULL;
ALTER TABLE customers ADD COLUMN legacy_code int;
UPDATE transactions SET amount = amount + 1 WHERE id = 424242;
DELETE FROM ledger_entries WHERE id IN (777001, 777002);
SQL
trap restore EXIT
echo "done: 4 schema changes, 3 bad rows"

step "3. F1+F2: what changed in the schema?"
run diff

step "4. F3+F4: which exact rows differ?" "Chunked checksums, then bisection down to the rows. Only hashes cross the network."
run verify --table transactions ledger_entries --rows

step "5. F5: is this migration safe to run in production?" "Lock analysis of examples/risky-migration.sql"
run locks examples/risky-migration.sql

step "6. F6: the same migration, rewritten to not block the app"
run rewrite examples/risky-migration.sql

step "7. F7+F11: a plan that makes target match source" "Rules-only, with risk, rollback SQL, and data-lossy steps held back."
run plan --no-llm

step "8. F10: prove the plan works on a throwaway copy" "A disposable Postgres container gets the target's schema, applies the plan, and is diffed against source."
run shadow --no-llm

step "9. F12: a tamper-evident receipt"
run receipt --no-llm --out /tmp/pgvouch-demo-receipt.json
run receipt-verify /tmp/pgvouch-demo-receipt.json
