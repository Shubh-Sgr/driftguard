-- A typical "looks fine in review" migration that would hurt in production.
CREATE INDEX idx_transactions_amount ON transactions (amount);
ALTER TABLE ledger_entries ADD FOREIGN KEY (account_id) REFERENCES accounts (id);
ALTER TABLE accounts ADD COLUMN external_ref uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE transactions ALTER COLUMN merchant_id TYPE bigint;
ALTER TABLE cards ALTER COLUMN network SET NOT NULL;
