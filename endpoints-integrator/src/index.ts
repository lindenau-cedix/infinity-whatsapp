// =============================================================================
// Public barrel for the Endpoints Integrator.
//
// The WhatsApp dispatcher imports `getAdapter(name, ctx)` and calls
// `adapter.run(prompt, ctx)`. Nothing else from this package should be
// imported by callers.
//
// INFA-17: the `qwenCode` branch is removed from this barrel. Qwen is
// served by `dispatcher/qwen.js` (LOCAL CLI: `qwen -m qwen3:30b-a3b -p`),
// wrapped into the adapter shape by `register.js`. The TS barrel no
// longer carries a Qwen class — there is no online endpoint.
// =============================================================================

export { loadCredentials, AuthError } from "./credentials.js";
export type { Credentials, AdapterKey, KeyName } from "./credentials.js";
export type { EndpointAdapter, PromptContext, Reply, MediaRef } from "./types.js";
export { PerplexityReasoningAdapter } from "./adapters/perplexityReasoning.js";
export { PerplexityDeepResearchAdapter } from "./adapters/perplexityDeepResearch.js";
export { FirecrawlAdapter } from "./adapters/firecrawl.js";

import type { EndpointAdapter, PromptContext } from "./types.js";
import { PerplexityReasoningAdapter } from "./adapters/perplexityReasoning.js";
import { PerplexityDeepResearchAdapter } from "./adapters/perplexityDeepResearch.js";
import { FirecrawlAdapter } from "./adapters/firecrawl.js";

export function getAdapter(
  name: "perplexityReasoning" | "perplexityDeepResearch" | "firecrawl",
  _ctx: PromptContext,
): EndpointAdapter {
  switch (name) {
    case "perplexityReasoning": return new PerplexityReasoningAdapter();
    case "perplexityDeepResearch": return new PerplexityDeepResearchAdapter();
    case "firecrawl": return new FirecrawlAdapter();
    case "qwenCode":
      // Qwen is served by `dispatcher/qwen.js` (LOCAL CLI). The
      // Integrator's `register.js` factory wraps that into the
      // `EndpointAdapter<Reply>` shape on the WhatsApp side; nothing in
      // this TS barrel should construct a Qwen adapter.
      throw new Error(
        "getAdapter: qwenCode is served by dispatcher/qwen.js, not by this TS barrel. " +
          "Import the JS adapter via register.js.",
      );
  }
}