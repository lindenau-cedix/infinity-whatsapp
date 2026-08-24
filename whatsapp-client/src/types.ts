// =============================================================================
// Shared types for the WhatsApp transport layer.
//
// `WhatsAppAdapter` is the transport-agnostic seam the Integrator depends on.
// Today it is implemented by `WWebJsAdapter` (uses whatsapp-web.js). A future
// adapter can swap in the WhatsApp Business Cloud API without touching the
// upstream dispatcher, by re-implementing this same interface.
//
// Shape decisions:
//   - `GroupConfig` lives in config.ts; we re-import the EndpointName type
//     so this module stays type-only.
//   - `IngressMessage.text` is the body after special-prefix detection has
//     *consumed* a "Grill Me:" or "Antworte sprachlich" prefix. The matched
//     flag is exposed on the message so the dispatcher doesn't re-parse.
//   - Media references are server-side absolute paths. Adapters MUST persist
//     downloads before emitting `message`, so the dispatcher can hand them to
//     downstream handlers without races.
// =============================================================================

import type { EndpointName, GroupConfig } from "./config.js";

export type { EndpointName, GroupConfig };

/** Kinds of attachment the WhatsApp client can persist to disk. */
export type AttachmentKind = "image" | "video" | "audio" | "document" | "unknown";

export interface MediaRef {
  /** Absolute filesystem path to the saved attachment. */
  path: string;
  /** Best-effort MIME type from whatsapp-web.js. */
  mime: string;
  /** Original filename if known. */
  filename?: string;
  /** Attachment kind — drives which downstream handler runs. */
  kind: AttachmentKind;
}

/**
 * What the adapter hands to the dispatcher when a new message arrives.
 *
 * Special prefixes are *stripped* from `text` and surfaced as boolean flags,
 * so the upstream code doesn't need to know about the trigger syntax. The
 * Integrator / Tech Lead decides what those flags mean end-to-end.
 */
export interface IngressMessage {
  /** Stable id from the underlying transport (used for idempotency). */
  transportId: string;
  /** Group the message came from, with the endpoint pre-resolved. */
  group: GroupConfig;
  /** Author contact id (so the dispatcher can dedupe per-user if needed). */
  authorId: string;
  /** Body text with any trigger prefix already removed. */
  text: string;
  /** Persisted attachments; empty array for text-only messages. */
  media: MediaRef[];
  /** True if the body started with the "Antworte sprachlich" trigger. */
  voiceReply: boolean;
  /** True if the body started with the "Grill Me:" trigger. */
  grillMe: boolean;
  /** Wall-clock ms when the transport delivered the message to us. */
  receivedAt: number;
}

/** What the dispatcher hands back to the adapter when an endpoint replies. */
export interface EgressReply {
  /** Text body. May be empty if `media` is non-empty. */
  text: string;
  /** Optional attachments to send (absolute paths). */
  media: MediaRef[];
  /**
   * If true, the reply should be sent as a voice note. The integrator /
   * tech lead is responsible for producing the audio bytes via ElevenLabs
   * and setting `text` to the path of the rendered audio file plus a
   * `media` entry of kind `audio`. This flag is a hint to the transport.
   */
  asVoice?: boolean;
}

/** Lifecycle events the adapter emits for logging / health endpoints. */
export type AdapterEvent =
  | { kind: "ready" }
  | { kind: "auth"; qr: string; pairingHint: string }
  | { kind: "reconnecting"; reason: string }
  | { kind: "disconnected"; reason: string }
  | { kind: "error"; error: Error };

export interface AdapterStatus {
  /** "ready" once authenticated, "pairing" while waiting for QR scan, etc. */
  state: "init" | "pairing" | "ready" | "reconnecting" | "stopped" | "error";
  lastError?: string;
  startedAt?: number;
}

/**
 * Transport-agnostic adapter interface. The Integrator / Tech Lead code
 * imports this and calls `start()` / `stop()` / `onMessage()` / `sendReply()`
 * only — never whatsapp-web.js directly. That is what makes the future
 * WhatsApp Business API swap a single-file change.
 */
export interface WhatsAppAdapter {
  /** Begin connecting; emits lifecycle events and ingress messages. */
  start(): Promise<void>;
  /** Gracefully shut down the underlying transport. */
  stop(): Promise<void>;
  /** Subscribe to inbound messages from the four configured groups only. */
  onMessage(handler: (msg: IngressMessage) => Promise<void> | void): void;
  /** Subscribe to lifecycle events for logging. */
  onEvent(handler: (ev: AdapterEvent) => void): void;
  /** Read current adapter state for `/healthz`-style endpoints. */
  getStatus(): AdapterStatus;
  /** Send a reply to a specific group JID. */
  sendReply(groupJid: string, reply: EgressReply): Promise<void>;
}
