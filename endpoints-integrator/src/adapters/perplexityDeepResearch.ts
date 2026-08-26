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
//
// INFA-24: deep-research was failing with "fetch failed" because the call
// exceeded the (then-unset) AbortController timeout and undici surfaced a
// generic TypeError that hid the real network cause. Now: 5min per attempt
// with 1 retry (matches Perplexity's documented 30s–5min bound) and the
// error envelope surfaces the underlying code (ECONNRESET, EAI_AGAIN, …)
// instead of just "fetch failed".
// =============================================================================

import type { EndpointAdapter, PromptContext, Reply } from "../types.js";
import { AuthError } from "../credentials.js";

const URL = "https://api.perplexity.ai/chat/completions";
const ATTEMPT_TIMEOUT_MS = 300_000; // 5min — upper bound of Perplexity's deep-research latency
const MAX_ATTEMPTS = 2;              // 1 + 1 retry (backoff ~2s)

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Walk `err.cause` chain to find the first entry with a useful code/name. */
function unwrapCause(err: unknown, depth = 0): { code?: string; name?: string; message?: string } {
  if (!err || depth > 5) return {};
  const e = err as { code?: string; name?: string; message?: string; cause?: unknown };
  if (e.code || e.name) return e;
  return unwrapCause(e.cause, depth + 1);
}

export class PerplexityDeepResearchAdapter implements EndpointAdapter {
  readonly name = "perplexityDeepResearch";

  async run(prompt: string, ctx: PromptContext): Promise<Reply> {
    const { apiKey, model } = ctx.credentials.perplexityDeepResearch;
    if (!apiKey) throw new AuthError("PERPLEXITY_DEEP_RESEARCH_API_KEY", this.name,
      "issue a key at https://www.perplexity.ai/settings/api");

    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
      try {
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
          signal: controller.signal,
        });

        if (res.status === 401 || res.status === 403) {
          throw new AuthError("PERPLEXITY_DEEP_RESEARCH_API_KEY", this.name,
            `provider rejected key (HTTP ${res.status}). Rotate at https://www.perplexity.ai/settings/api`);
        }
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          const e = new Error(`HTTP ${res.status} ${res.statusText} — ${errText.slice(0, 200)}`);
          (e as Error & { status?: number }).status = res.status;
          throw e;
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
      } catch (err) {
        lastErr = err;
        clearTimeout(timer);
        const status = (err as { status?: number })?.status;
        if (status === 401 || status === 403) throw err; // never retry on auth
        if (attempt === MAX_ATTEMPTS) break;
        await sleep(2_000);
      } finally {
        clearTimeout(timer);
      }
    }

    const inner = unwrapCause(lastErr);
    const detail = inner.code || inner.name
      ? `${(lastErr as Error)?.message ?? "fetch failed"} (${inner.code ?? inner.name})`
      : (lastErr as Error)?.message ?? "fetch failed";
    const err = new Error(`[perplexityDeepResearch] all retries exhausted: ${detail}`);
    (err as Error & { cause?: unknown }).cause = lastErr;
    throw err;
  }
}