-- Deterministic seed data. Every value is derived from the generate_series counter `i`
-- (no random(), no now()), so source-db and target-db end up byte-for-byte identical.
-- That is what lets F3 checksums start from "everything matches".

INSERT INTO currencies (code, name, minor_units) VALUES
  ('INR', 'Indian Rupee', 2),
  ('USD', 'US Dollar', 2),
  ('GBP', 'Pound Sterling', 2),
  ('SGD', 'Singapore Dollar', 2),
  ('AED', 'UAE Dirham', 2);

INSERT INTO customers (id, email, full_name, country, kyc_status, created_at)
SELECT i,
       'customer' || i || '@example.com',
       'Customer ' || i,
       (ARRAY['IN', 'US', 'GB', 'SG', 'AE'])[1 + i % 5],
       CASE WHEN i % 20 = 0 THEN 'rejected' WHEN i % 7 = 0 THEN 'pending' ELSE 'verified' END,
       timestamptz '2023-01-01 00:00:00+00' + i * interval '47 minutes'
FROM generate_series(1, 10000) AS i;

INSERT INTO accounts (id, customer_id, currency, account_type, balance, opened_at)
SELECT i,
       1 + (i - 1) % 10000,
       (ARRAY['INR', 'USD', 'GBP', 'SGD', 'AED'])[1 + i % 5],
       (ARRAY['checking', 'savings', 'wallet'])[1 + i % 3],
       ((i::bigint * 7919) % 10000000) / 100.0,
       timestamptz '2023-02-01 00:00:00+00' + i * interval '23 minutes'
FROM generate_series(1, 20000) AS i;

INSERT INTO account_limits (account_id, limit_type, amount)
SELECT a, lt, CASE lt WHEN 'daily_spend' THEN 5000 + (a % 50) * 100 ELSE 1000 + (a % 20) * 50 END
FROM generate_series(1, 20000) AS a
CROSS JOIN (VALUES ('daily_spend'), ('atm_withdrawal')) AS l(lt);

INSERT INTO merchants (id, name, mcc, country)
SELECT i,
       'Merchant ' || i,
       lpad(((i * 37) % 9000 + 1000)::text, 4, '0'),
       (ARRAY['IN', 'US', 'GB', 'SG', 'AE'])[1 + i % 5]
FROM generate_series(1, 1000) AS i;

INSERT INTO cards (id, account_id, last4, network, expires_on, is_active)
SELECT i,
       1 + (i * 13) % 20000,
       lpad(((i * 7) % 10000)::text, 4, '0'),
       (ARRAY['visa', 'mastercard', 'rupay'])[1 + i % 3],
       date '2027-01-01' + (i % 1000),
       i % 17 <> 0
FROM generate_series(1, 15000) AS i;

-- ~1M transactions. account_id is computed once in the subquery so `currency`
-- can match the account's currency (same formula as in accounts above).
INSERT INTO transactions (id, account_id, merchant_id, amount, currency, kind, status, reference, metadata, created_at)
SELECT i,
       acct,
       CASE WHEN i % 4 = 0 THEN NULL ELSE 1 + (i * 17) % 1000 END,
       ((i::bigint * 104729) % 500000 + 1) / 100.0,
       (ARRAY['INR', 'USD', 'GBP', 'SGD', 'AED'])[1 + acct % 5],
       CASE i % 10 WHEN 0 THEN 'refund' WHEN 1 THEN 'transfer' WHEN 2 THEN 'fee' ELSE 'purchase' END,
       CASE WHEN i % 50 = 0 THEN 'reversed' WHEN i % 13 = 0 THEN 'pending' ELSE 'posted' END,
       md5('txn-' || i)::uuid,
       CASE WHEN i % 3 = 0
            THEN jsonb_build_object('channel', (ARRAY['app', 'web', 'pos'])[1 + (i / 3) % 3], 'retry', i % 2 = 0)
       END,
       timestamptz '2024-01-01 00:00:00+00' + i * interval '30 seconds'
FROM generate_series(1, 1000000) AS i
CROSS JOIN LATERAL (SELECT 1 + (i::bigint * 31) % 20000 AS acct) AS a;

-- Two ledger rows per transaction: debit the payer, credit a counter-account.
INSERT INTO ledger_entries (id, transaction_id, account_id, direction, amount, created_at)
SELECT t.id * 2 - CASE d.direction WHEN 'debit' THEN 1 ELSE 0 END,
       t.id,
       CASE d.direction WHEN 'debit' THEN t.account_id ELSE 1 + t.account_id % 20000 END,
       d.direction,
       t.amount,
       t.created_at
FROM transactions t
CROSS JOIN (VALUES ('debit'), ('credit')) AS d(direction);

INSERT INTO fx_rates (base, quote, rate, as_of)
SELECT b.code, q.code,
       -- A deterministic, non-round double so float text formatting is exercised.
       (ascii(b.code) * 31 + ascii(q.code) * 17 + d) % 1000 / 97.0 + 0.01,
       date '2024-01-01' + d
FROM currencies b
CROSS JOIN currencies q
CROSS JOIN generate_series(0, 364) AS d
WHERE b.code <> q.code;

INSERT INTO audit_log (id, entity, entity_id, action, payload, created_at)
SELECT i,
       (ARRAY['account', 'card', 'customer'])[1 + i % 3],
       1 + (i * 7) % 10000,
       (ARRAY['created', 'updated', 'status_changed'])[1 + i % 3],
       jsonb_build_object('field', 'status', 'old', 'active', 'new', CASE WHEN i % 2 = 0 THEN 'frozen' ELSE 'active' END),
       timestamptz '2024-06-01 00:00:00+00' + i * interval '5 minutes'
FROM generate_series(1, 50000) AS i;

-- We inserted explicit ids, so move each identity sequence past the max id;
-- otherwise the next INSERT without an id would collide.
SELECT setval(pg_get_serial_sequence('customers', 'id'), (SELECT max(id) FROM customers));
SELECT setval(pg_get_serial_sequence('accounts', 'id'), (SELECT max(id) FROM accounts));
SELECT setval(pg_get_serial_sequence('merchants', 'id'), (SELECT max(id) FROM merchants));
SELECT setval(pg_get_serial_sequence('cards', 'id'), (SELECT max(id) FROM cards));
SELECT setval(pg_get_serial_sequence('transactions', 'id'), (SELECT max(id) FROM transactions));
SELECT setval(pg_get_serial_sequence('ledger_entries', 'id'), (SELECT max(id) FROM ledger_entries));
SELECT setval(pg_get_serial_sequence('audit_log', 'id'), (SELECT max(id) FROM audit_log));

-- Populate planner statistics now: F5 reads pg_class.reltuples for row estimates,
-- and it's -1 ("unknown") until the table has been analyzed.
ANALYZE;
