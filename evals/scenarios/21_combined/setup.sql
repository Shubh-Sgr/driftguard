-- Several kinds of drift at once
DROP INDEX cards_account_id_idx;
ALTER TABLE customers ADD COLUMN nickname text;
ALTER TABLE accounts ALTER COLUMN balance TYPE numeric(20,2);
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_account_id_fkey;
CREATE TABLE import_staging (id bigint);
