// =============================================================================
// Shared types for the Endpoints Integrator.
//
// EndpointAdapter — single method `run(prompt, ctx) → Reply`. This is the
// contract that the WhatsApp dispatcher (owned by Integrator / Tech Lead)
// consumes; do not change the shape without sign-off from Tech Lead.
//
// Reply.text is the outbound text the dispatcher will hand to WhatsApp.
// Reply.mediaRefs is a list of filesystem paths the model produced; the
// dispatcher passes them through to WhatsApp as attachments. We never
// base64-inject media into prompts; we pass path references.
// =============================================================================

import type { Credentials } from "./credentials.js";

export interface MediaRef {
  /** Absolute path on the Infinity server. */
  path: string;
  /** MIME type, best-effort. */
  mime: string;
  /** Optional caption the model wants attached. */
  caption?: string;
}

export interface PromptContext {
  /** Unique id for this prompt; pass through to provider for tracing. */
  requestId: string;
  /** WhatsApp group this prompt came from; useful for logging only. */
  group: "Qwen" | "Perp. RP" | "Perp. DR" | "Firecrawl";
  /** Server-side media paths already saved by the dispatcher; model can read them. */
  mediaPaths: string[];
  /** Caller-provided credentials slice (only the keys this adapter needs). */
  credentials: Credentials;
}

export interface Reply {
  text: string;
  /** Files the model produced that should be attached to the WhatsApp reply. */
  mediaRefs: MediaRef[];
  /** Token usage / latency, surfaced for monitoring. */
  usage?: { inputTokens?: number; outputTokens?: number; latencyMs?: number };
}

export interface EndpointAdapter {
  readonly name: string;
  run(prompt: string, ctx: PromptContext): Promise<Reply>;
}