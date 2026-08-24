// =============================================================================
// Public barrel for the Endpoints Integrator.
//
// The WhatsApp dispatcher imports `getAdapter(name, ctx)` and calls
// `adapter.run(prompt, ctx)`. Nothing else from this package should be
// imported by callers.
// =============================================================================

export { loadCredentials, AuthError } from "./credentials.js";
export type { Credentials, AdapterKey, KeyName } from "./credentials.js";
export type { EndpointAdapter, PromptContext, Reply, MediaRef } from "./types.js";
export { QwenCodeAdapter } from "./adapters/qwenCode.js";
export { PerplexityReasoningAdapter } from "./adapters/perplexityReasoning.js";
export { PerplexityDeepResearchAdapter } from "./adapters/perplexityDeepResearch.js";
export { FirecrawlAdapter } from "./adapters/firecrawl.js";

import type { EndpointAdapter, PromptContext } from "./types.js";
import { QwenCodeAdapter } from "./adapters/qwenCode.js";
import { PerplexityReasoningAdapter } from "./adapters/perplexityReasoning.js";
import { PerplexityDeepResearchAdapter } from "./adapters/perplexityDeepResearch.js";
import { FirecrawlAdapter } from "./adapters/firecrawl.js";

export function getAdapter(
  name: "qwenCode" | "perplexityReasoning" | "perplexityDeepResearch" | "firecrawl",
  _ctx: PromptContext,
): EndpointAdapter {
  switch (name) {
    case "qwenCode": return new QwenCodeAdapter();
    case "perplexityReasoning": return new PerplexityReasoningAdapter();
    case "perplexityDeepResearch": return new PerplexityDeepResearchAdapter();
    case "firecrawl": return new FirecrawlAdapter();
  }
}