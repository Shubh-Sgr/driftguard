-- Changes in a composite-PK table and in a table without a PK
UPDATE account_limits SET amount = 1 WHERE account_id = 777 AND limit_type = 'atm_withdrawal';
UPDATE fx_rates SET rate = rate + 0.000001 WHERE base = 'USD' AND quote = 'INR' AND as_of = '2024-03-01';
