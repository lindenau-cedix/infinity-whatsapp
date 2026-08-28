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
    const mediaPaths = msg.media.map((m) => m.path);
    const ctx: IntegratorContext = {
      requestId,
      group: msg.group.label,
      mediaPaths,
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
    // Image / video messages frequently arrive with no body at all (the
    // caption field on whatsapp-web.js is *not* the same as `body`). The
    // Integrator's `dispatch()` rejects empty prompts outright, which used
    // to surface as "Fehler bei qwenCode: dispatch: prompt must be a
    // non-empty string" the moment a user sent a bare photo. INFA-27
    // follow-up: when the body is empty but media is present, build the
    // analysis prompt from the saved paths so the qwen analyser still has
    // something non-empty to invoke against — matching the INFA-27 spec
    // ("Analyse this media: [PATH TO MEDIA SOURCE]"). If both body and
    // media are empty we emit a clear operator-visible reply rather than
    // surfacing a generic Integrator error.
    const prompt =
      msg.text.length > 0
        ? msg.text
        : buildMediaPrompt(mediaPaths) || "(empty message — no body or media)";
    let reply: IntegratorReply;
    try {
      reply = await adapter.run(prompt, ctx);
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

/**
 * Build a non-empty prompt for the Integrator when the inbound body is
 * empty but the message carried persisted attachments. The shape mirrors
 * the INFA-27 spec ("Analyse this media: [PATH TO MEDIA SOURCE]") and
 * keeps the qwen analyser dispatch chain from rejecting with
 * `prompt must be a non-empty string`. INFA-27 follow-up.
 */
function buildMediaPrompt(mediaPaths: string[]): string {
  if (mediaPaths.length === 0) return "";
  if (mediaPaths.length === 1) {
    return `Analyse this media: ${mediaPaths[0]}`;
  }
  return `Analyse this media (${mediaPaths.length} attachments):\n` +
    mediaPaths.map((p) => `- ${p}`).join("\n");
}
