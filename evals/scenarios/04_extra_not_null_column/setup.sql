-- Extra NOT NULL column on target
ALTER TABLE customers ADD COLUMN risk_score int NOT NULL DEFAULT 0;
