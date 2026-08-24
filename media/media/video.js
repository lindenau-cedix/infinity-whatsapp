// =============================================================================
// Inbound video handler.
//
// Same envelope as image.js — write the bytes to `./media/videos/`, hand back
// the absolute path. Hard cap at VIDEO_MAX_BYTES; throw `MediaError` with code
// `too_large` if a 50 MB 3gp would otherwise fill the disk.
// =============================================================================

import * as path from "node:path";
import { VIDEO_MIME_TYPES, VIDEO_MAX_BYTES } from "./_constants.js";
import { mediaDir, mediaFilename } from "./_paths.js";
import { writeMediaToDisk } from "./_download.js";
import { MediaError } from "./_errors.js";

/**
 * Save a video from a WhatsApp inbound message and return its absolute path.
 *
 * @param {{ id: string, mimeType: string, body?: Buffer, url?: string, caption?: string }} message
 * @param {{ mediaDir?: string, maxBytes?: number }} [opts]
 * @returns {Promise<{ path: string, mime: string, caption?: string, bytes: number }>}
 * @throws {MediaError} on unsupported MIME, oversize payload, or download failure
 */
export async function saveVideo(message, opts = {}) {
  if (!message || typeof message !== "object") {
    throw new MediaError("missing_payload", "saveVideo: message is required");
  }
  const { mimeType, id, caption } = message;
  const ext = VIDEO_MIME_TYPES[mimeType];
  if (!ext) {
    throw new MediaError(
      "unsupported_mime",
      `saveVideo: mimeType ${mimeType ?? "<unset>"} is not supported (accept: ${Object.keys(VIDEO_MIME_TYPES).join(", ")})`,
    );
  }
  const cap = opts.maxBytes ?? VIDEO_MAX_BYTES;
  const dir = mediaDir(opts.mediaDir, "videos");
  const dest = path.join(dir, mediaFilename(id ?? "anon", ext));
  const bytes = await writeMediaToDisk(
    { buffer: message.body, url: message.url },
    dest,
    cap,
    MediaError,
    { fetchImpl: opts.fetchImpl },
  );
  return { path: dest, mime: mimeType, caption, bytes };
}
