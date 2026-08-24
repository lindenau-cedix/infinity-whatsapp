// =============================================================================
// Media persistence. Downloads whatsapp-web.js attachments to
// `<mediaDir>/inbox/<messageId>-<n>.<ext>` so paths are stable across runs.
//
// The dispatcher then hands those absolute paths to the Voice & Media
// Engineer for transcription / vision; we never base64-inject media.
// =============================================================================

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Logger } from "./logger.js";
import type { AttachmentKind, MediaRef } from "./types.js";

interface DownloadableAttachment {
  /** whatsapp-web.js MessageMedia object — has `data` (base64) and `mimetype`. */
  getMedia(): Promise<{ data: string; mimetype: string; filename?: string }>;
}

export class MediaStore {
  private readonly inboxDir: string;

  constructor(
    private readonly mediaDir: string,
    private readonly log: Logger,
  ) {
    this.inboxDir = path.join(mediaDir, "inbox");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.inboxDir, { recursive: true });
  }

  /**
   * Persist a single attachment. Returns absolute path on disk plus metadata
   * the downstream handler can use to pick a Whisper / vision pipeline.
   *
   * whatsapp-web.js exposes media via `Message.getMedia()`; this method
   * accepts the result of that call rather than the Message itself so this
   * class is testable in isolation and survives API drift in the library.
   */
  async persist(
    transportId: string,
    index: number,
    attachment: DownloadableAttachment,
    kind: AttachmentKind,
  ): Promise<MediaRef> {
    const media = await attachment.getMedia();
    const ext = extensionFor(media.mimetype, media.filename);
    const safeId = sanitize(transportId);
    const filename = `${safeId}-${index}.${ext}`;
    const absolutePath = path.join(this.inboxDir, filename);
    const buffer = Buffer.from(media.data, "base64");
    await fs.writeFile(absolutePath, buffer);
    this.log.info("media.persisted", {
      path: absolutePath,
      mime: media.mimetype,
      bytes: buffer.length,
      kind,
    });
    return {
      path: absolutePath,
      mime: media.mimetype,
      filename: media.filename ?? filename,
      kind,
    };
  }
}

function extensionFor(mime: string, filename?: string): string {
  if (filename && path.extname(filename)) {
    return path.extname(filename).slice(1).toLowerCase();
  }
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/3gpp": "3gp",
    "audio/ogg; codecs=opus": "ogg",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "application/pdf": "pdf",
    "application/octet-stream": "bin",
  };
  return map[mime] ?? "bin";
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64);
}

/**
 * Picks an attachment kind from a MIME type. Conservative default — unknown
 * MIME types are persisted with kind "unknown" so the upstream dispatcher
 * can decide what to do rather than us silently dropping them.
 */
export function classifyAttachment(mime: string): AttachmentKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf" || mime.startsWith("application/")) return "document";
  return "unknown";
}
