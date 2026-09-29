-- Foreign key present but NOT VALID
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_transaction_id_fkey;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES transactions (id) NOT VALID;
