-- Read-only role that DriftGuard (CLI + MCP server) connects as.
-- Three independent layers stop it from writing:
--   1. privileges: it only ever gets SELECT;
--   2. default_transaction_read_only: every transaction starts READ ONLY;
--   3. DriftGuard also sets it again per connection (src/db.ts).
-- The password is a local Docker test value, not a secret.
CREATE ROLE driftguard_ro LOGIN PASSWORD 'driftguard_ro_local';

ALTER ROLE driftguard_ro SET default_transaction_read_only = on;
-- Server-side safety net in case a client forgets its own timeout.
ALTER ROLE driftguard_ro SET statement_timeout = '60s';
-- Don't let a crashed client hold a snapshot open (it would hold back VACUUM).
ALTER ROLE driftguard_ro SET idle_in_transaction_session_timeout = '60s';

GRANT CONNECT ON DATABASE fintech TO driftguard_ro;
GRANT USAGE ON SCHEMA public TO driftguard_ro;

-- Applies to tables created later by `postgres` (the seed below and eval scenarios).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO driftguard_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON SEQUENCES TO driftguard_ro;
