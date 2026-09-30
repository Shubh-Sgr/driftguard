-- Type change on a column that has a foreign key (merchant_id -> merchants)
ALTER TABLE transactions ALTER COLUMN merchant_id TYPE bigint;
