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
      // whatsapp-web.js@1.23.0 ships a `LocalWebCache` whose `persist()`
      // does `indexHtml.match(/manifest-([\d\\.]+)\.json/)[1]` with no
      // null check. As of late August 2026 WhatsApp's served
      // https://web.whatsapp.com/ no longer contains a `manifest-X.Y.Z.json`
      // reference, so the regex returns null and the persist path throws
      // `TypeError: Cannot read properties of null (reading '1')` during
      // client.initialize(), which kills the whole adapter before it ever
      // reaches the QR / message-stream code path.
      //
      // The cache itself is only an optimization: when it returns `null`
      // from `resolve()`, `Client.js` re-fetches the live `index.html`
      // from WhatsApp on every startup. Disabling the cache via
      // `type: "none"` makes `persist()` a no-op (the base `WebCache`
      // implementation), which is exactly what we want until the
      // upstream library is fixed. INFA-27 boot crash workaround.
      webVersionCache: {
        type: "none",
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
      // Once the session is ready, validate that the four JIDs in .env
      // actually correspond to groups the WA account is a member of. INFA-20
      // was a silent routing hole when one of those JIDs was mistyped — the
      // operator saw only Qwen messages flow and had no signal pointing at
      // the wrong env var. We list the joined groups and emit a single
      // warning per misconfigured endpoint so the cause is obvious.
      this.validateConfiguredJids().catch((err) => {
        // Surface more than just `message`: a non-Error throw (e.g. whatsapp-
        // web.js rejecting with a bare string like `"r"`) used to log
        // `error: "r"` and leave the operator guessing. INFA-20 follow-up.
        this.log.warn("wa.jid_validation_failed", {
          error: errorMsg(err),
          errorName: err instanceof Error ? err.name : typeof err,
          errorCode:
            err && typeof err === "object" && "code" in err
              ? String((err as { code?: unknown }).code ?? "")
              : "",
        });
      });
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

  /**
   * After the WA session reports ready, list the joined groups and compare
   * them against the four JIDs the operator set in .env. A misconfigured
   * JID silently turns a group into a black hole (route() drops the
   * message because findGroupByJid can't match it), which is exactly the
   * "only Qwen group works" symptom that opened INFA-20. We log one
   * warning per endpoint that is missing from the joined list and a
   * single info-level summary of how many matched, so the operator can
   * see at a glance which env var to fix.
   */
  private async validateConfiguredJids(): Promise<void> {
    // whatsapp-web.js exposes the chats list; groups are chats whose
    // id._serialized ends with '@g.us'. We pull id, name, and subject so
    // the warning text is operator-readable, not just opaque JIDs.
    type GroupChat = { id: { _serialized: string }; name?: string; subject?: string };
    const chats = (await (this.client as unknown as {
      getChats: () => Promise<unknown[]>;
    }).getChats()) as GroupChat[];
    const joined = new Map<string, GroupChat>();
    for (const c of chats) {
      const id = c?.id?._serialized;
      if (typeof id === "string" && id.endsWith("@g.us")) {
        joined.set(id, c);
      }
    }

    const matched: string[] = [];
    const missing: { endpoint: string; jid: string }[] = [];
    for (const cfg of Object.values(this.groups)) {
      if (joined.has(cfg.jid)) {
        matched.push(cfg.jid);
      } else {
        missing.push({ endpoint: cfg.endpoint, jid: cfg.jid });
      }
    }

    if (missing.length === 0) {
      this.log.info("wa.jid_validation.ok", {
        matchedCount: matched.length,
        joinedCount: joined.size,
      });
      return;
    }

    // Build a small list of joined JIDs the operator can eyeball against
    // the .env. We cap at 20 to keep the log line readable; most users
    // have far fewer than that.
    const joinedSample = [...joined.keys()].slice(0, 20);
    this.log.warn("wa.jid_validation.mismatch", {
      missing,
      joinedCount: joined.size,
      joinedSample,
      hint:
        "A configured WA_GROUP_JID_* does not correspond to any group the " +
        "WA account is a member of. Messages from that chat will be " +
        "ignored at the router. Run `infinity-whatsapp --check-groups` " +
        "to see the configured JIDs; pull the real JID from WhatsApp " +
        "(group info → invite link) and update .env.",
    });
  }

  private attachMessageStream(): void {
    this.client.on("message", (raw: unknown) => {
      const msg = raw as WWebJsMessage;
      // Skip our own outgoing messages and protocol-level chatter.
      if (msg.fromMe) return;
      // whatsapp-web.js occasionally hands the adapter a notification or
      // protocol-level payload (typing indicator, poll vote, ephemeral ack,
      // etc.). We only drop messages we cannot route on at all — i.e. the
      // `from` JID is missing AND there is no body and no media to act on.
      //
      // We deliberately do NOT require a populated `msg.id._serialized`
      // here: real image / video messages can arrive while their store
      // entry is still being hydrated (the 2026-08-28 incident:
      // `wa.message.ignored_unparseable ... type:"image" hasId:false
      // hasBody:true`). The INFA-27 follow-up's id-strict gate silently
      // dropped those and broke the media → qwen analyser dispatch. The
      // route() defense-in-depth line below fabricates a safe fallback id
      // when it is missing, so downstream code never dereferences
      // `msg.id._serialized` on a non-string. INFA-27 hardening.
      if (!isRoutable(msg)) {
        this.log.info("wa.message.ignored_unparseable", {
          from: typeof msg.from === "string" ? msg.from : null,
          type: typeof msg.type === "string" ? msg.type : null,
          hasId: Boolean(msg.id && typeof msg.id._serialized === "string"),
          hasBody: typeof msg.body === "string",
          hasMedia: typeof msg.hasMedia === "boolean" ? msg.hasMedia : null,
          reason: routableRejectReason(msg),
        });
        return;
      }
      // Anything that survives isRoutable but still throws inside route()
      // (e.g. a malformed wwebjs payload whose `from` JID is fine but whose
      // body / author / media handle is unexpected) used to surface as
      // `wa.message.failed error:"r"` because wwebjs swallows the original
      // TypeError into a single-character rejection. Wrap the whole route()
      // so an unexpected shape becomes a single warn line carrying the
      // real error message and shape snapshot, not a red herring.
      this.route(msg).catch((err) => {
        this.log.warn("wa.message.ignored_unparseable", {
          from: typeof msg.from === "string" ? msg.from : null,
          type: typeof msg.type === "string" ? msg.type : null,
          hasId: Boolean(msg.id && typeof msg.id._serialized === "string"),
          hasBody: typeof msg.body === "string",
          hasMedia: typeof msg.hasMedia === "boolean" ? msg.hasMedia : null,
          reason: "route_threw",
          error: errorMsg(err),
          errorName: err instanceof Error ? err.name : typeof err,
          errorStack: err instanceof Error ? (err.stack ?? null) : null,
        });
      });
    });
  }

  private async route(msg: WWebJsMessage): Promise<void> {
    // Defense in depth: if a routable-looking msg (per isRoutable) still
    // ends up here without an id, synthesize a fallback so downstream code
    // that reads msg.id._serialized does not throw. INFA-27 hardening.
    if (!msg.id || typeof msg.id._serialized !== "string") {
      msg.id = { id: "unknown", _serialized: "unknown" };
    }
    const chatJid = msg.from;
    const group = findGroupByJid(chatJid, this.groups);
    if (!group) {
      // Not one of the four configured groups. Previously this returned
      // silently, which made INFA-20's "only Qwen group works" symptom look
      // like a routing black hole — operators saw no log line at all and
      // could not distinguish a JID typo from a wiring bug. Emit a single
      // info-level line so the dropped message is visible, and include the
      // list of configured JIDs as a hint that they probably need to
      // double-check their .env. INFA-20.
      this.log.info("wa.message.ignored_no_group", {
        from: chatJid,
        author: typeof msg.author === "string" ? msg.author : null,
        configuredJids: Object.values(this.groups).map((g) => g.jid),
        bodyBytes: (typeof msg.body === "string" ? msg.body : "").length,
      });
      return;
    }

    const bodyText = typeof msg.body === "string" ? msg.body : "";
    const { text, voiceReply, grillMe } = parseTriggers(bodyText);
    // Guard media collection so a single bad attachment does not abort
    // the whole message — we still want the text branch (if any) to be
    // delivered. The pre-2026-08-28 behavior was: collectAttachments
    // throws on an unavailable media → route() rejects → message
    // listener catch fires → operator sees `wa.message.failed` and
    // nothing else. After the media.unavailable guard above this should
    // be unreachable for the documented case, but the belt-and-braces
    // catch here covers any future regression.
    let media: IngressMessage["media"] = [];
    try {
      media = await this.collectAttachments(msg);
    } catch (err) {
      this.log.error("media.persist_failed", {
        id: msg.id?._serialized ?? null,
        from: typeof msg.from === "string" ? msg.from : null,
        error: errorMsg(err),
      });
      media = [];
    }

    const ingress: IngressMessage = {
      transportId: msg.id._serialized,
      group,
      authorId: typeof msg.author === "string" ? msg.author : chatJid,
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
    // whatsapp-web.js downloadMedia() resolves to `undefined` (not throws)
    // in three real-world cases:
    //   (a) the message has no media after a late re-classification,
    //   (b) the WA mediaStage is still FETCHING when the event fires,
    //   (c) the page-eval returns undefined because the store entry was
    //       not hydrated yet.
    // Until 2026-08-28 we passed that undefined into MediaStore.persist,
    // which then dereferenced `.data` and crashed the whole route() chain
    // — surfacing as `wa.message.failed error="Cannot read properties of
    // undefined (reading 'data')"`. Treat the unavailable case as zero
    // attachments, log it so the operator can correlate, and let the text
    // branch (if any) continue. INFA-27 media availability fix.
    const messageMedia = await msg.downloadMedia();
    if (!messageMedia || !messageMedia.data) {
      this.log.info("media.unavailable", {
        from: typeof msg.from === "string" ? msg.from : null,
        id: msg.id?._serialized ?? null,
        type: typeof msg.type === "string" ? msg.type : null,
        kind,
        reason: !messageMedia
          ? "downloadMedia_returned_undefined"
          : "messageMedia_data_undefined",
      });
      return [];
    }
    // Synthesize the small interface MediaStore needs without re-importing
    // the MessageMedia shape — keeps the dependency boundary clean.
    const adapter = {
      getMedia: async () => ({
        data: messageMedia.data,
        mimetype: messageMedia.mimetype,
        filename: messageMedia.filename ?? undefined,
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

// A message is "routable" if we have something to act on: a `from` JID we
// can route to a configured group, and either a body or media to process.
// We do not require a populated `msg.id._serialized` — image / video
// payloads can arrive before their store entry is hydrated, and the
// route() function synthesises a safe fallback id for downstream code.
//
// We additionally filter known protocol-level / non-content message types
// that wwebjs hands us without an actionable body or media:
//   - "typing" / "recording"   — presence indicators
//   - "revoked"                — a deleted-for-everyone message
//   - "notification"           — generic server-pushed notice
//   - "e2e_notification"       — encryption handshake / sync notice
//   - "protocol"               — raw protocol ack
//   - "poll_vote" / "poll_creation" — WhatsApp poll events (no text body
//     we want to forward to an LLM; poll_vote messages never carry one)
//   - "gp2"                    — group protocol (member add/remove/promote)
//   - "ciphertext"             — undecryptable stub before keys sync
// Filtering these at the gate stops them reaching route() at all, so the
// "r" TypeError noise (wwebjs swallows the real cause) stops appearing as
// `wa.message.failed`. INFA-27 follow-up hardening.
const NON_ROUTABLE_TYPES: ReadonlySet<string> = new Set([
  "typing",
  "recording",
  "revoked",
  "notification",
  "e2e_notification",
  "protocol",
  "poll_vote",
  "poll_creation",
  "gp2",
  "ciphertext",
]);

function isRoutable(msg: WWebJsMessage): boolean {
  if (!msg || typeof msg !== "object") return false;
  if (typeof msg.from !== "string" || msg.from.length === 0) return false;
  if (typeof msg.body !== "string" && !msg.hasMedia) return false;
  if (typeof msg.type === "string" && NON_ROUTABLE_TYPES.has(msg.type)) return false;
  return true;
}

/**
 * Operator-readable reason the message was filtered. Kept as a separate
 * helper so the `wa.message.ignored_unparseable` log line tells the
 * operator *why* a payload was dropped, not just that it was.
 */
function routableRejectReason(msg: WWebJsMessage): string {
  if (!msg || typeof msg !== "object") return "not_an_object";
  if (typeof msg.from !== "string" || msg.from.length === 0) return "missing_from_jid";
  if (typeof msg.body !== "string" && !msg.hasMedia) return "no_body_no_media";
  if (typeof msg.type === "string" && NON_ROUTABLE_TYPES.has(msg.type)) {
    return `protocol_payload:${msg.type}`;
  }
  return "unknown";
}
