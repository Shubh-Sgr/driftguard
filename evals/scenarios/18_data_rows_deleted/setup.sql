-- Three rows missing from 2M ledger entries
DELETE FROM ledger_entries WHERE id IN (777001, 777002, 1999999);
