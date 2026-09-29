-- Run once on the scratch copy before measuring, so a few statements below have
-- something valid to act on (a nullable column with no NULLs, a NOT VALID check).
ALTER TABLE merchants ADD COLUMN region text DEFAULT 'IN';
ALTER TABLE cards ADD CONSTRAINT cards_last4_len CHECK (length(last4) = 4) NOT VALID;
