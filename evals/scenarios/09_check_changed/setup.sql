-- CHECK constraint allows an extra value
ALTER TABLE customers DROP CONSTRAINT customers_kyc_status_check;
ALTER TABLE customers ADD CONSTRAINT customers_kyc_status_check CHECK (kyc_status IN ('pending', 'verified', 'rejected', 'expired'));
