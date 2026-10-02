-- Row-level security policy dropped and RLS turned off on target
DROP POLICY audit_log_read ON audit_log;
ALTER TABLE audit_log DISABLE ROW LEVEL SECURITY;
