// =============================================================================
// Inbound image handler.
//
// The WhatsApp Client Engineer hands us a message shape and we hand back the
// absolute on-disk path. The dispatcher passes that path into the prompt
// envelope (`mediaPaths`) — adapters read the file themselves, never base64.
//
// Accepted payload shape from WhatsApp:
//   { id, mimeType, body?, caption?, url? }
//
// We accept `body` (already-downloaded Buffer) for the in-process test rig and
// `url` for the real WhatsApp flow. Either way we end up on disk under
// `./media/images/<unix_ms>_<id>.<ext>`.
// =============================================================================

import * as path from "node:path";
import { IMAGE_MIME_TYPES, IMAGE_MAX_BYTES } from "./_constants.js";
import { mediaDir, mediaFilename } from "./_paths.js";
import { writeMediaToDisk } from "./_download.js";
import { MediaError } from "./_errors.js";

/**
 * Save an image from a WhatsApp inbound message and return its absolute path.
 *
 * @param {{ id: string, mimeType: string, body?: Buffer, url?: string, caption?: string }} message
 * @param {{ mediaDir?: string }} [opts]
 * @returns {Promise<{ path: string, mime: string, caption?: string, bytes: number }>}
 * @throws {MediaError} on unsupported MIME, oversize payload, or download failure
 */
export async function saveImage(message, opts = {}) {
  if (!message || typeof message !== "object") {
    throw new MediaError("missing_payload", "saveImage: message is required");
  }
  const { mimeType, id, caption } = message;
  const ext = IMAGE_MIME_TYPES[mimeType];
  if (!ext) {
    throw new MediaError(
      "unsupported_mime",
      `saveImage: mimeType ${mimeType ?? "<unset>"} is not supported (accept: ${Object.keys(IMAGE_MIME_TYPES).join(", ")})`,
    );
  }
  const dir = mediaDir(opts.mediaDir, "images");
  const dest = path.join(dir, mediaFilename(id ?? "anon", ext));
  const bytes = await writeMediaToDisk(
    { buffer: message.body, url: message.url },
    dest,
    IMAGE_MAX_BYTES,
    MediaError,
    { fetchImpl: opts.fetchImpl },
  );
  return { path: dest, mime: mimeType, caption, bytes };
}
