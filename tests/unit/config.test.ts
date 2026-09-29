import { describe, expect, it } from "vitest";
import { loadConfig, redactUrl } from "../../src/config.js";

const valid = {
  SOURCE_DATABASE_URL: "postgres://ro:pw@localhost:5433/fintech",
  TARGET_DATABASE_URL: "postgresql://ro:pw@localhost:5434/fintech",
};

describe("loadConfig", () => {
  it("parses valid env and applies the default timeout", () => {
    expect(loadConfig(valid)).toMatchObject({
      sourceUrl: valid.SOURCE_DATABASE_URL,
      targetUrl: valid.TARGET_DATABASE_URL,
      statementTimeoutMs: 30_000,
      llm: { provider: "ollama", ollamaModel: "llama3.2" },
    });
  });

  it("coerces the timeout from a string", () => {
    expect(loadConfig({ ...valid, DRIFTGUARD_STATEMENT_TIMEOUT_MS: "5000" }).statementTimeoutMs).toBe(5000);
  });

  it("rejects a missing target URL and names the variable", () => {
    expect(() => loadConfig({ SOURCE_DATABASE_URL: valid.SOURCE_DATABASE_URL })).toThrow(/TARGET_DATABASE_URL/);
  });

  it("rejects non-postgres URLs", () => {
    expect(() => loadConfig({ ...valid, SOURCE_DATABASE_URL: "mysql://x@y/z" })).toThrow(/postgres:\/\//);
  });

  it("rejects a zero or negative timeout", () => {
    expect(() => loadConfig({ ...valid, DRIFTGUARD_STATEMENT_TIMEOUT_MS: "0" })).toThrow(/DRIFTGUARD_STATEMENT_TIMEOUT_MS/);
  });

  it("shadow-verifies LLM plans by default; DRIFTGUARD_SHADOW_VERIFY=off turns it off", () => {
    expect(loadConfig(valid).shadowVerify).toBe(true);
    expect(loadConfig({ ...valid, DRIFTGUARD_SHADOW_VERIFY: "off" }).shadowVerify).toBe(false);
    expect(() => loadConfig({ ...valid, DRIFTGUARD_SHADOW_VERIFY: "false" })).toThrow(/DRIFTGUARD_SHADOW_VERIFY/);
  });

  it("rejects an unknown LLM provider", () => {
    expect(() => loadConfig({ ...valid, DRIFTGUARD_LLM: "gpt" })).toThrow(/DRIFTGUARD_LLM/);
  });
});

describe("redactUrl", () => {
  it("hides the password but keeps the user and host", () => {
    expect(redactUrl("postgres://ro:s3cret@db:5432/app")).toBe("postgres://ro:***@db:5432/app");
  });

  it("leaves URLs without a password unchanged", () => {
    expect(redactUrl("postgres://db:5432/app")).toBe("postgres://db:5432/app");
  });
});
