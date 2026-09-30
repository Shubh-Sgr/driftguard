-- Type change on a foreign-key column that is also in a multi-column index
ALTER TABLE transactions ALTER COLUMN account_id TYPE integer;
