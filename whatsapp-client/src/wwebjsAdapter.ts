// =============================================================================
// WWebJsAdapter — concrete implementation of `WhatsAppAdapter` backed by
// `whatsapp-web.js`. Owns:
//   - LocalAuth session persistence to `<sessionPath>/wwebjs_auth`
//   - QR-code pairing (printed to terminal via qrcode-terminal)
//   - Lifecycle logging (connect / reconnect / auth / errors)
//   - Group-only filtering (ignores messages from non-configured chats)
//   - Attachment download to MediaStore
//   - Reconnect on transient drops with capped exponential backoff
//
// The future WhatsApp Business API adapter implements the same
// `WhatsAppAdapter` interface in a sibling file. Nothing in this adapter is
// imported by the dispatcher / config / types modules.
// =============================================================================

import { Client, LocalAuth, MessageMedia } from "whatsapp-web.js";
// qrcode-terminal ships without a declaration file; declare just the surface
// we actually use so the rest of the codebase stays strictly typed.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const qrcode: { generate: (text: string, opts?: { small?: boolean }) => void } =
  require("qrcode-terminal");
import type { GroupConfig, RuntimeConfig } from "./config.js";
import { findGroupByJid } from "./config.js";
import { Logger } from "./logger.js";
import { MediaStore, classifyAttachment } from "./media.js";
import { parseTriggers } from "./triggers.js";
import type {
  AdapterEvent,
  AdapterStatus,
  EgressReply,
  IngressMessage,
  WhatsAppAdapter,
} from "./types.js";

type MessageHandler = (msg: IngressMessage) => Promise<void> | void;
type EventHandler = (ev: AdapterEvent) => void;

interface WWebJsMessage {
  id: { id: string; _serialized: string };
  from: string;
  author?: string;
  body: string;
  hasMedia: boolean;
  downloadMedia?: () => Promise<MessageMedia>;
  type: string;
  fromMe?: boolean;
}

interface WWebJsChat {
  id: { _serialized: string };
}

export class WWebJsAdapter implements WhatsAppAdapter {
  private client: Client;
  private status: AdapterStatus = { state: "init" };
  private messageHandlers: MessageHandler[] = [];
  private eventHandlers: EventHandler[] = [];
  private log: Logger;
  private reconnectAttempts = 0;
  private stopped = false;

  constructor(
    private readonly groups: Record<string, GroupConfig>,
    private readonly runtime: RuntimeConfig,
    private readonly media: MediaStore,
  ) {
    this.log = new Logger("whatsapp", runtime.logLevel);
    this.client = new Client({
      authStrategy: new LocalAuth({
        clientId: "infinity",
        dataPath: runtime.sessionPath,
      }),
      puppeteer: {
        headless: runtime.headless,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      },
    });
    this.wireLifecycle();
  }

  async start(): Promise<void> {
    await this.media.init();
    this.status.startedAt = Date.now();
    this.log.info("adapter.start", {
      sessionPath: this.runtime.sessionPath,
      headless: this.runtime.headless,
      mediaDir: this.runtime.mediaDir,
    });
    this.attachMessageStream();
    try {
      await this.client.initialize();
    } catch (err) {
      this.status = { state: "error", lastError: errorMsg(err) };
      this.emit({ kind: "error", error: asError(err) });
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try {
      await this.client.destroy();
    } catch (err) {
      this.log.warn("adapter.stop.destroy_failed", { error: errorMsg(err) });
    }
    this.status = { ...this.status, state: "stopped" };
    this.log.info("adapter.stopped");
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onEvent(handler: EventHandler): void {
    this.eventHandlers.push(handler);
  }

  getStatus(): AdapterStatus {
    return { ...this.status };
  }

  async sendReply(groupJid: string, reply: EgressReply): Promise<void> {
    const chatId = this.normalizeChatId(groupJid);
    try {
      if (reply.asVoice && reply.text) {
        // The Integrator / Voice & Media Engineer is responsible for turning
        // `text` into an audio file *before* the dispatcher calls us. If we
        // see `asVoice=true` with text, we assume the text is already a path
        // to a rendered audio file (mirrors what the Integrator's `Reply`
        // contract does for mediaRefs). We treat it as an audio attachment.
        const voicePath = reply.text.trim();
        const voiceMedia = MessageMedia.fromFilePath(voicePath);
        await this.client.sendMessage(chatId, voiceMedia, {
          sendAudioAsVoice: true,
        });
        return;
      }
      if (reply.media.length > 0) {
        for (const m of reply.media) {
          const media = MessageMedia.fromFilePath(m.path);
          await this.client.sendMessage(chatId, media, {
            caption: reply.text || undefined,
          });
        }
        return;
      }
      if (reply.text) {
        await this.client.sendMessage(chatId, reply.text);
      }
    } catch (err) {
      this.log.error("sendReply.failed", {
        chatId,
        error: errorMsg(err),
      });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Private wiring
  // ---------------------------------------------------------------------------

  private wireLifecycle(): void {
    this.client.on("qr", (qr: string) => {
      this.status = { state: "pairing" };
      this.log.info("wa.qr");
      // Render QR in the terminal so a human can scan with their phone.
      qrcode.generate(qr, { small: true });
      this.emit({ kind: "auth", qr, pairingHint: "scan the QR with your phone" });
    });

    this.client.on("authenticated", () => {
      this.reconnectAttempts = 0;
      this.log.info("wa.authenticated");
    });

    this.client.on("auth_failure", (msg: string) => {
      this.status = { state: "error", lastError: `auth_failure: ${msg}` };
      this.log.error("wa.auth_failure", { msg });
      this.emit({ kind: "error", error: new Error(`auth_failure: ${msg}`) });
    });

    this.client.on("ready", () => {
      this.status = { state: "ready", startedAt: this.status.startedAt };
      this.reconnectAttempts = 0;
      this.log.info("wa.ready");
      this.emit({ kind: "ready" });
    });

    this.client.on("disconnected", (reason: string) => {
      this.log.warn("wa.disconnected", { reason });
      this.emit({ kind: "disconnected", reason });
      if (this.stopped) return;
      this.scheduleReconnect(reason);
    });

    this.client.on("change_state", (state: unknown) => {
      this.log.info("wa.state", { state: String(state) });
    });
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    this.status = { state: "reconnecting", lastError: reason };
    const attempt = ++this.reconnectAttempts;
    // Capped exponential backoff: 1s, 2s, 4s, 8s, … up to 30s.
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5));
    this.emit({ kind: "reconnecting", reason: `attempt=${attempt} delayMs=${delay}` });
    this.log.warn("wa.reconnect.scheduled", { attempt, delayMs: delay });
    setTimeout(() => {
      if (this.stopped) return;
      this.client.initialize().catch((err) => {
        this.log.error("wa.reconnect.failed", { error: errorMsg(err) });
        this.scheduleReconnect(errorMsg(err));
      });
    }, delay).unref();
  }

  private attachMessageStream(): void {
    this.client.on("message", (raw: unknown) => {
      const msg = raw as WWebJsMessage;
      // Skip our own outgoing messages and protocol-level chatter.
      if (msg.fromMe) return;
      this.route(msg).catch((err) => {
        this.log.error("wa.message.failed", {
          id: msg.id?._serialized,
          from: msg.from,
          error: errorMsg(err),
        });
      });
    });
  }

  private async route(msg: WWebJsMessage): Promise<void> {
    const chatJid = msg.from;
    const group = findGroupByJid(chatJid, this.groups);
    if (!group) {
      // Not one of the four configured groups — silently ignore.
      return;
    }

    const { text, voiceReply, grillMe } = parseTriggers(msg.body ?? "");
    const media = await this.collectAttachments(msg);

    const ingress: IngressMessage = {
      transportId: msg.id._serialized,
      group,
      authorId: msg.author ?? chatJid,
      text,
      media,
      voiceReply,
      grillMe,
      receivedAt: Date.now(),
    };

    this.log.info("ingress.message", {
      transportId: ingress.transportId,
      group: group.label,
      endpoint: group.endpoint,
      voiceReply,
      grillMe,
      media: media.length,
      textBytes: text.length,
    });

    for (const h of this.messageHandlers) {
      await h(ingress);
    }
  }

  private async collectAttachments(msg: WWebJsMessage): Promise<IngressMessage["media"]> {
    if (!msg.hasMedia || !msg.downloadMedia) return [];
    const kind = classifyAttachment(this.previewMime(msg));
    const media = await msg.downloadMedia();
    // Synthesize the small interface MediaStore needs without re-importing
    // the MessageMedia shape — keeps the dependency boundary clean.
    const adapter = {
      getMedia: async () => ({
        data: media.data,
        mimetype: media.mimetype,
        filename: media.filename ?? undefined,
      }),
    };
    return [await this.media.persist(msg.id._serialized, 0, adapter, kind)];
  }

  private previewMime(msg: WWebJsMessage): string {
    // whatsapp-web.js attaches the mime to MessageMedia on the Message
    // itself in some versions; fall back to a type-keyed map.
    const m = (msg as unknown as { _media?: { mimetype?: string } })._media;
    if (m?.mimetype) return m.mimetype;
    switch (msg.type) {
      case "image": return "image/jpeg";
      case "video": return "video/mp4";
      case "ptt":
      case "audio": return "audio/ogg; codecs=opus";
      case "document": return "application/octet-stream";
      default: return "application/octet-stream";
    }
  }

  private emit(ev: AdapterEvent): void {
    for (const h of this.eventHandlers) {
      try {
        h(ev);
      } catch (err) {
        this.log.error("event.handler.failed", { error: errorMsg(err) });
      }
    }
  }

  private normalizeChatId(jid: string): string {
    return jid;
  }
}

function errorMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
