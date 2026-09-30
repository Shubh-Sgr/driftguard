import { SOURCE_ADMIN_URL as SOURCE_ADMIN_MAINTENANCE_URL, withDatabase } from "../../evals/lib/scratch.js";

// Connection defaults live in evals/lib/scratch.ts (shared with the eval suite) and
// match docker/docker-compose.yml. CI can override them with env vars.
export { SOURCE_RO_URL, TARGET_RO_URL, TARGET_ADMIN_URL } from "../../evals/lib/scratch.js";

// Rows in `transactions` the databases were seeded with (docker-compose.yml). CI uses a
// small seed, so tests derive counts and row ids from this instead of assuming 1M.
export const SEED_TRANSACTIONS = Number(process.env.SEED_TRANSACTIONS ?? 1_000_000);

// Superuser URL for the seeded database — used ONLY by tests, never by PgVouch code.
export const SOURCE_ADMIN_URL = withDatabase(SOURCE_ADMIN_MAINTENANCE_URL, "fintech");
