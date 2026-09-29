import { LlmError, type LlmProvider } from "./provider.js";

/**
 * Google Gemini (free tier), for environments without a local GPU/Ollama.
 * The API key comes from the environment (GEMINI_API_KEY), never from tool input.
 * https://ai.google.dev/api/generate-content
 */
export class GeminiProvider implements LlmProvider {
  readonly id: string;

  constructor(
    private readonly apiKey: string,
    private readonly model = "gemini-2.0-flash",
    private readonly timeoutMs = 120_000,
  ) {
    this.id = `gemini:${model}`;
  }

  async complete({ system, prompt }: { system: string; prompt: string; jsonSchema: object }): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    const res = await fetch(url, {
      method: "POST",
      // Key in a header, not the URL, so it doesn't end up in logs.
      headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        // JSON mode. (We validate with zod afterwards either way.)
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new LlmError(`Gemini returned ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  }
}
