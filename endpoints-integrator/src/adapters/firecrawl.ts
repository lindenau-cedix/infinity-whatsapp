// =============================================================================
// Adapter: Firecrawl (web scrape + structured extraction).
//
// This adapter is not a chat model — it returns Markdown (or JSON) extracted
// from a URL. The dispatcher is responsible for choosing Firecrawl when the
// prompt looks like "scrape this URL" / "summarize this page" (group:
// Firecrawl). The model produces *no* media; we return mediaRefs empty.
//
// Quirks:
//   - Two endpoints: /v1/scrape (single URL, sync) and /v1/crawl (multi-URL
//     async job). We use /v1/scrape because Infinity's group-by-group
//     interaction is per-message.
//   - Auth: `Authorization: Bearer <FIRECRAWL_API_KEY>`. Note: Firecrawl
//     historically accepted `X-Api-Key` too; Bearer is canonical now.
//   - Response format options: `markdown` (default), `json`, `summary`. We
//     default to markdown so the dispatcher can hand it to a chat model
//     later if it wants to.
//   - We pass the URL via the prompt. The adapter parses the first URL out
//     of the prompt; if none, we return a clear "no URL" error.
// =============================================================================

import type { EndpointAdapter, PromptContext, Reply } from "../types.js";
import { AuthError } from "../credentials.js";

const URL_RE = /\bhttps?:\/\/[^\s)\]]+/i;

export class FirecrawlAdapter implements EndpointAdapter {
  readonly name = "firecrawl";

  async run(prompt: string, ctx: PromptContext): Promise<Reply> {
    const { apiKey, baseUrl } = ctx.credentials.firecrawl;
    if (!apiKey) throw new AuthError("FIRECRAWL_API_KEY", this.name,
      "issue a key at https://firecrawl.dev");

    const match = prompt.match(URL_RE);
    if (!match) {
      return {
        text: "Firecrawl adapter needs a URL. Send a message like: `scrape https://example.com`.",
        mediaRefs: [],
      };
    }
    const target = match[0];

    const url = `${baseUrl.replace(/\/$/, "")}/v1/scrape`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Request-Id": ctx.requestId,
      },
      body: JSON.stringify({
        url: target,
        formats: ["markdown"],
        onlyMainContent: true,
      }),
    });

    if (res.status === 401 || res.status === 403) {
      throw new AuthError("FIRECRAWL_API_KEY", this.name,
        `provider rejected key (HTTP ${res.status}). Rotate at https://firecrawl.dev`);
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`firecrawl: HTTP ${res.status} ${res.statusText} — ${errText.slice(0, 200)}`);
    }

    const json = (await res.json()) as {
      data?: { markdown?: string; metadata?: { title?: string; description?: string } };
    };
    const md = json.data?.markdown ?? "";
    const title = json.data?.metadata?.title ?? target;
    const head = md.length > 3500 ? md.slice(0, 3500) + "\n\n[…truncated…]" : md;
    return {
      text: `*${title}*\n\n${head}`,
      mediaRefs: [],
    };
  }
}