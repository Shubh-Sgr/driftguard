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
  PGVOUCH_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // Planner LLM (F7). "none" = rules-only plans; nothing is sent anywhere. It is the
  // default: a tool that teams run on company databases must never contact a model
  // (even a local one) unless someone turned that on explicitly.
  PGVOUCH_LLM: z.enum(["ollama", "gemini", "none"]).default("none"),
  OLLAMA_URL: z.string().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().default("llama3.2"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.0-flash"),
  // Shadow-run every LLM plan before accepting it (needs Docker). "off" = validator only.
  PGVOUCH_SHADOW_VERIFY: z.enum(["on", "off"]).default("on"),
});

export interface Config {
  sourceUrl: string;
  targetUrl: string;
  statementTimeoutMs: number;
  /** Accept an LLM plan only after a passing shadow run. */
  shadowVerify: boolean;
  llm: {
    provider: "ollama" | "gemini" | "none";
    ollamaUrl: string;
    ollamaModel: string;
    geminiApiKey?: string;
    geminiModel: string;
  };
}

/** Validates the environment once, at startup, and fails with a readable message. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid PgVouch configuration:\n${problems}\nSee .env.example.`);
  }
  return {
    sourceUrl: parsed.data.SOURCE_DATABASE_URL,
    targetUrl: parsed.data.TARGET_DATABASE_URL,
    statementTimeoutMs: parsed.data.PGVOUCH_STATEMENT_TIMEOUT_MS,
    shadowVerify: parsed.data.PGVOUCH_SHADOW_VERIFY === "on",
    llm: {
      provider: parsed.data.PGVOUCH_LLM,
      ollamaUrl: parsed.data.OLLAMA_URL,
      ollamaModel: parsed.data.OLLAMA_MODEL,
      geminiApiKey: parsed.data.GEMINI_API_KEY,
      geminiModel: parsed.data.GEMINI_MODEL,
    },
  };
}

/** For logs and error messages: never print a password. */
export function redactUrl(url: string): string {
  return url.replace(/\/\/([^:/@]+):[^@]*@/, "//$1:***@");
}
