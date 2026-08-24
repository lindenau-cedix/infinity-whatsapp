// =============================================================================
// Dispatcher — receives IngressMessage from the adapter, talks to the
// Endpoints Integrator's adapter contract, and writes the reply back through
// the adapter.
//
// This module is deliberately thin. It does NOT know about Qwen / Perplexity
// / Firecrawl / Whisper / ElevenLabs directly — those belong to the
// Endpoints Integrator and the Voice & Media Engineer. We import the
// Integrator's `getAdapter` and `EndpointAdapter` types by *interface* only,
// so the project remains buildable while the Integrator module is in a
// sibling workspace. Wiring is via constructor injection.
// =============================================================================

import * as crypto from "node:crypto";
import type { Logger } from "./logger.js";
import type {
  EgressReply,
  IngressMessage,
  WhatsAppAdapter,
} from "./types.js";

/**
 * The shape the Integrator exposes. Re-declared here (rather than imported)
 * so the WhatsApp client project compiles standalone before the Integrator
 * package is linked. The Integrator module satisfies this exact contract.
 */
export interface IntegratorAdapter {
  readonly name: string;
  run(prompt: string, ctx: IntegratorContext): Promise<IntegratorReply>;
}

export interface IntegratorContext {
  requestId: string;
  group: string;
  mediaPaths: string[];
}

export interface IntegratorReply {
  text: string;
  mediaRefs: { path: string; mime: string; caption?: string }[];
  usage?: { inputTokens?: number; outputTokens?: number; latencyMs?: number };
}

/**
 * Factory the Integrator owns. We accept a function (not the module) so this
 * file stays free of `require("../endpoints-integrator/infinity/...")`
 * cross-workspace paths — the Integrator registers itself at boot.
 */
export type AdapterFactory = (
  name: "qwenCode" | "perplexityReasoning" | "perplexityDeepResearch" | "firecrawl",
) => IntegratorAdapter;

export class Dispatcher {
  constructor(
    private readonly adapter: WhatsAppAdapter,
    private readonly getAdapter: AdapterFactory,
    private readonly log: Logger,
  ) {}

  /** Bind to the adapter's message stream. Returns an unsubscribe function. */
  bind(): () => void {
    this.adapter.onMessage((msg) => {
      this.handle(msg).catch((err) => {
        this.log.error("dispatcher.handle.failed", {
          transportId: msg.transportId,
          group: msg.group.label,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
    return () => this.log.info("dispatcher.unbound");
  }

  private async handle(msg: IngressMessage): Promise<void> {
    const requestId = crypto.randomUUID();
    const ctx: IntegratorContext = {
      requestId,
      group: msg.group.label,
      mediaPaths: msg.media.map((m) => m.path),
    };

    this.log.info("dispatch.received", {
      requestId,
      transportId: msg.transportId,
      group: msg.group.label,
      endpoint: msg.group.endpoint,
      voiceReply: msg.voiceReply,
      grillMe: msg.grillMe,
      mediaCount: msg.media.length,
    });

    const adapter = this.getAdapter(msg.group.endpoint);
    let reply: IntegratorReply;
    try {
      reply = await adapter.run(msg.text, ctx);
    } catch (err) {
      const text = `⚠️ Fehler bei ${adapter.name}: ${
        err instanceof Error ? err.message : String(err)
      }`;
      await this.adapter.sendReply(msg.group.jid, { text, media: [] });
      return;
    }

    const egress: EgressReply = {
      text: reply.text,
      asVoice: msg.voiceReply,
      media: reply.mediaRefs.map((m) => ({
        path: m.path,
        mime: m.mime,
        kind: "document", // Integrator-produced attachments don't carry our AttachmentKind
        filename: m.caption ?? undefined,
      })),
    };

    this.log.info("dispatch.reply", {
      requestId,
      endpoint: adapter.name,
      latencyMs: reply.usage?.latencyMs,
      outMedia: egress.media.length,
      voice: !!egress.asVoice,
    });

    await this.adapter.sendReply(msg.group.jid, egress);
  }
}
