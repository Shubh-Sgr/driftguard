import { SOURCE_ADMIN_URL as SOURCE_ADMIN_MAINTENANCE_URL, withDatabase } from "../../evals/lib/scratch.js";

// Connection defaults live in evals/lib/scratch.ts (shared with the eval suite) and
// match docker/docker-compose.yml. CI can override them with env vars.
export { SOURCE_RO_URL, TARGET_RO_URL, TARGET_ADMIN_URL } from "../../evals/lib/scratch.js";

// Superuser URL for the seeded database — used ONLY by tests, never by DriftGuard code.
export const SOURCE_ADMIN_URL = withDatabase(SOURCE_ADMIN_MAINTENANCE_URL, "fintech");
