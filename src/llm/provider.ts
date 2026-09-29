/**
 * The only thing the planner needs from an LLM: prompt in, JSON text out.
 * Keeping the interface this small makes providers swappable (Ollama locally,
 * Gemini's free tier online) and lets tests use a fake provider.
 */
export interface LlmProvider {
  /** e.g. "ollama:llama3.2" — recorded in plans and eval results. */
  readonly id: string;
  /**
   * Returns the model's raw text. `jsonSchema` asks for structured output where the
   * provider supports it; the caller still validates everything it gets back.
   */
  complete(request: { system: string; prompt: string; jsonSchema: object }): Promise<string>;
}

export class LlmError extends Error {}
