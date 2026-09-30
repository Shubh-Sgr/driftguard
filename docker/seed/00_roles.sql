-- Read-only role that PgVouch (CLI + MCP server) connects as.
-- Three independent layers stop it from writing:
--   1. privileges: it only ever gets SELECT;
--   2. default_transaction_read_only: every transaction starts READ ONLY;
--   3. PgVouch also sets it again per connection (src/db.ts).
-- The password is a local Docker test value, not a secret.
CREATE ROLE pgvouch_ro LOGIN PASSWORD 'pgvouch_ro_local';

ALTER ROLE pgvouch_ro SET default_transaction_read_only = on;
-- Server-side safety net in case a client forgets its own timeout.
ALTER ROLE pgvouch_ro SET statement_timeout = '60s';
-- Don't let a crashed client hold a snapshot open (it would hold back VACUUM).
ALTER ROLE pgvouch_ro SET idle_in_transaction_session_timeout = '60s';

GRANT CONNECT ON DATABASE fintech TO pgvouch_ro;
GRANT USAGE ON SCHEMA public TO pgvouch_ro;

-- Applies to tables created later by `postgres` (the seed below and eval scenarios).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO pgvouch_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON SEQUENCES TO pgvouch_ro;

-- Lets `pgvouch preflight` see other sessions' states and transaction ages in
-- pg_stat_activity (without it: "limited visibility"; lock conflicts still work).
-- It also allows reading their query text; PgVouch never returns or stores it.
GRANT pg_read_all_stats TO pgvouch_ro;
