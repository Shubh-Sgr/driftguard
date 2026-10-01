-- Trigger function body changed on target
CREATE OR REPLACE FUNCTION audit_log_set_created_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END
$$;
