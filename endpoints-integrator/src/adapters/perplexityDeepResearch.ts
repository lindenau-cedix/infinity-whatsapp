// =============================================================================
// Adapter: Perplexity sonar-deep-research.
//
// Quirks:
//   - Deep-research is a *research* job, not a one-shot completion. The model
//     may run for 30s–5min. We hit the synchronous /chat/completions endpoint
//     because Perplexity returns the full report in one response when the
//     model is "sonar-deep-research"; long-polling is not required.
//   - Citations are returned in `citations[]` on the response. We do not
//     surface them as text but log them for the Voice & Media Engineer to
//     use in voice mode if it wants to read sources aloud.
//   - Same auth pattern as sonar-reasoning-pro, but we keep a separate env
//     var so one product can be rotated without the other.
// =============================================================================

import type { EndpointAdapter, PromptContext, Reply } from "../types.js";
import { AuthError } from "../credentials.js";

const URL = "https://api.perplexity.ai/chat/completions";

export class PerplexityDeepResearchAdapter implements EndpointAdapter {
  readonly name = "perplexityDeepResearch";

  async run(prompt: string, ctx: PromptContext): Promise<Reply> {
    const { apiKey, model } = ctx.credentials.perplexityDeepResearch;
    if (!apiKey) throw new AuthError("PERPLEXITY_DEEP_RESEARCH_API_KEY", this.name,
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
      throw new AuthError("PERPLEXITY_DEEP_RESEARCH_API_KEY", this.name,
        `provider rejected key (HTTP ${res.status}). Rotate at https://www.perplexity.ai/settings/api`);
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`perplexityDeepResearch: HTTP ${res.status} ${res.statusText} — ${errText.slice(0, 200)}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      citations?: string[];
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