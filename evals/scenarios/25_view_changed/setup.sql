-- View definition changed on target
CREATE OR REPLACE VIEW customer_account_counts AS
  SELECT c.id AS customer_id, c.country, count(a.id) AS accounts
  FROM customers c
  LEFT JOIN accounts a ON a.customer_id = c.id AND a.account_type <> 'wallet'
  GROUP BY c.id, c.country;
