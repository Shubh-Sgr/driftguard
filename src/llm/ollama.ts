import { LlmError, type LlmProvider } from "./provider.js";

/**
 * Ollama runs models locally: free, and the schema never leaves the machine.
 * https://github.com/ollama/ollama/blob/main/docs/api.md#generate-a-chat-completion
 */
export class OllamaProvider implements LlmProvider {
  readonly id: string;

  constructor(
    private readonly model = "llama3.2",
    private readonly baseUrl = "http://localhost:11434",
    private readonly timeoutMs = 180_000,
  ) {
    this.id = `ollama:${model}`;
  }

  async complete({ system, prompt, jsonSchema }: { system: string; prompt: string; jsonSchema: object }): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          // Structured output: Ollama constrains generation to this JSON schema.
          format: jsonSchema,
          // temperature 0 + fixed seed = as reproducible as the model allows.
          // num_ctx: Ollama's default context (often 4096 tokens) silently truncates
          // our prompt (rules + table facts, ~3-4k tokens); 8192 fits it plus the answer
          // without the extra memory 16k would cost. num_predict caps runaway output.
          options: { temperature: 0, seed: 42, num_ctx: 8_192, num_predict: 2_048 },
          // Unload the model 30 s after the last request instead of keeping ~2.5 GB loaded.
          keep_alive: "30s",
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new LlmError(`Could not reach Ollama at ${this.baseUrl} (${(err as Error).message}). Is \`ollama serve\` running?`);
    }
    if (!res.ok) throw new LlmError(`Ollama returned ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { message?: { content?: string } };
    return body.message?.content ?? "";
  }
}
