-- Partial-index predicate changed
DROP INDEX transactions_pending_idx;
CREATE INDEX transactions_pending_idx ON transactions (created_at) WHERE status IN ('pending', 'reversed');
