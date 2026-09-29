#!/bin/sh
# Loads the seed data. It's a shell script (not .sql) only so the row count can be
# passed in: SEED_TRANSACTIONS (default 1M) -> psql variable :transactions.
set -e
psql -v ON_ERROR_STOP=1 -v transactions="${SEED_TRANSACTIONS:-1000000}" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -f /docker-entrypoint-initdb.d/data.psql
