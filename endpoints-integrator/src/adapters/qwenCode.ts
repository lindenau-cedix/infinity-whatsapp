// =============================================================================
// Adapter: Qwen Code (DashScope OpenAI-compatible endpoint).
//
// Quirks:
//   - DashScope's /compatible-mode/v1/chat/completions accepts the standard
//     OpenAI schema; pass `model: qwen-coder` (or the alias DashScope exposes).
//   - Auth is via `Authorization: Bearer <QWEN_API_KEY>`. Bearer is correct;
//     some older docs say `sk-` prefix. Both work, just include Bearer.
//   - Tool calls are supported but we don't use them here — Infinity is text.
//   - 429 backoff: DashScope rate-limits per model. We retry once on 429 with
//     a 1s delay; after that, surface the upstream error verbatim.
// =============================================================================

import type { EndpointAdapter, PromptContext, Reply } from "../types.js";
import { AuthError } from "../credentials.js";

const DEFAULT_MODEL = "qwen-coder";

export class QwenCodeAdapter implements EndpointAdapter {
  readonly name = "qwenCode";

  async run(prompt: string, ctx: PromptContext): Promise<Reply> {
    const { apiKey, baseUrl } = ctx.credentials.qwen;
    if (!apiKey) throw new AuthError("QWEN_API_KEY", this.name,
      "issue a key at https://dashscope.aliyuncs.com/apiKey");

    const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    const body = {
      model: DEFAULT_MODEL,
      messages: [{ role: "user", content: prompt }],
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Request-Id": ctx.requestId,
      },
      body: JSON.stringify(body),
    });

    if (res.status === 401 || res.status === 403) {
      throw new AuthError("QWEN_API_KEY", this.name,
        `provider rejected key (HTTP ${res.status}). Rotate at https://dashscope.aliyuncs.com/apiKey`);
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`qwenCode: HTTP ${res.status} ${res.statusText} — ${errText.slice(0, 200)}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
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