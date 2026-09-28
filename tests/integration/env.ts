// Defaults match docker/docker-compose.yml, so `npm run db:up && npm run test:integration`
// works with no extra setup. CI can override them with env vars.
export const SOURCE_RO_URL =
  process.env.SOURCE_DATABASE_URL ?? "postgres://driftguard_ro:driftguard_ro_local@localhost:5433/fintech";
export const TARGET_RO_URL =
  process.env.TARGET_DATABASE_URL ?? "postgres://driftguard_ro:driftguard_ro_local@localhost:5434/fintech";

// Superuser URL — used ONLY by tests/evals to set up scenarios, never by DriftGuard code.
export const SOURCE_ADMIN_URL =
  process.env.SOURCE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5433/fintech";
