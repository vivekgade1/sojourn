import type { CriticLLM } from "@sojourn/core";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const REQUEST_TIMEOUT_MS = 30_000;

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicMessagesResponse {
  content?: AnthropicContentBlock[];
}

/**
 * Builds a `CriticLLM` that calls the real Anthropic Messages API. Used to
 * power the Tier-2 advisory critic (`runCritic` from `@sojourn/core`). Never
 * called by the T1 pipeline — only reachable when a caller explicitly opts
 * into T2 and `ANTHROPIC_API_KEY` is set.
 *
 * `fetchImpl` is injectable so callers (and tests) can avoid touching the
 * network; it defaults to the global `fetch`.
 */
export function anthropicCritic(apiKey: string, fetchImpl: typeof fetch = fetch): CriticLLM {
  return {
    async complete(prompt: string): Promise<string> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: process.env.SOJOURN_CRITIC_MODEL ?? DEFAULT_MODEL,
            max_tokens: 1024,
            messages: [{ role: "user", content: prompt }],
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const bodyText = await res.text().catch(() => "");
          throw new Error(
            `Anthropic Messages API returned ${res.status} ${res.statusText}: ${bodyText}`,
          );
        }

        const data = (await res.json()) as AnthropicMessagesResponse;
        const blocks = Array.isArray(data.content) ? data.content : [];
        return blocks
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("");
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
