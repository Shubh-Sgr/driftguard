import { z } from "zod";

// Connection strings always come from the local environment — never from a CLI
// argument an AI assistant could fill in, and never from MCP tool input.
const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\//, "must be a postgres:// or postgresql:// URL");

const EnvSchema = z.object({
  SOURCE_DATABASE_URL: postgresUrl,
  TARGET_DATABASE_URL: postgresUrl,
  // Env vars are strings, so coerce to a number before validating.
  DRIFTGUARD_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
});

export interface Config {
  sourceUrl: string;
  targetUrl: string;
  statementTimeoutMs: number;
}

/** Validates the environment once, at startup, and fails with a readable message. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid DriftGuard configuration:\n${problems}\nSee .env.example.`);
  }
  return {
    sourceUrl: parsed.data.SOURCE_DATABASE_URL,
    targetUrl: parsed.data.TARGET_DATABASE_URL,
    statementTimeoutMs: parsed.data.DRIFTGUARD_STATEMENT_TIMEOUT_MS,
  };
}

/** For logs and error messages: never print a password. */
export function redactUrl(url: string): string {
  return url.replace(/\/\/([^:/@]+):[^@]*@/, "//$1:***@");
}
