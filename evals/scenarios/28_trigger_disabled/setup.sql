-- Trigger disabled on target (its logic silently stops)
ALTER TABLE audit_log DISABLE TRIGGER audit_log_created_at;
