-- One value changed in 1M transactions (no schema drift)
UPDATE transactions SET amount = amount + 0.01 WHERE id = 543210;
