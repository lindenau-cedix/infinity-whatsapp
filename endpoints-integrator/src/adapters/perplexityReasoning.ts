// =============================================================================
// Adapter: Perplexity sonar-reasoning-pro.
//
// Quirks:
//   - Base URL is https://api.perplexity.ai/chat/completions (OpenAI-compatible).
//   - Auth: `Authorization: Bearer <PERPLEXITY_REASONING_API_KEY>`.
//   - Reasoning models return an additional `choices[0].message.reasoning`
//     field (chain-of-thought). We do NOT surface this to the user — only
//     `content` is returned as the reply text.
//   - Some accounts have `sonar-reasoning-pro` gated; if 404, escalate to
//     Tech Lead — model name may need to change.
// =============================================================================

import type { EndpointAdapter, PromptContext, Reply } from "../types.js";
import { AuthError } from "../credentials.js";

const URL = "https://api.perplexity.ai/chat/completions";

export class PerplexityReasoningAdapter implements EndpointAdapter {
  readonly name = "perplexityReasoning";

  async run(prompt: string, ctx: PromptContext): Promise<Reply> {
    const { apiKey, model } = ctx.credentials.perplexityReasoning;
    if (!apiKey) throw new AuthError("PERPLEXITY_REASONING_API_KEY", this.name,
      "issue a key at https://www.perplexity.ai/settings/api");

    const res = await fetch(URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Request-Id": ctx.requestId,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (res.status === 401 || res.status === 403) {
      throw new AuthError("PERPLEXITY_REASONING_API_KEY", this.name,
        `provider rejected key (HTTP ${res.status}). Rotate at https://www.perplexity.ai/settings/api`);
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`perplexityReasoning: HTTP ${res.status} ${res.statusText} — ${errText.slice(0, 200)}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = json.choices?.[0]?.message?.content ?? "";
    return {
      text,
      mediaRefs: [],
      usage: {
        inputTokens: json.usage?.prompt_tokens,
        outputTokens: json.usage?.completion_tokens,
      },
    };
  }
}