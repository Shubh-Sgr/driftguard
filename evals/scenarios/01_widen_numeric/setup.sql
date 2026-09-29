-- Widening type change (numeric(12,2) -> numeric(16,2))
ALTER TABLE accounts ALTER COLUMN balance TYPE numeric(16,2);
