// =============================================================================
// Bytes-on-disk helper.
//
// Used by image.js / video.js / voice.js to stream WhatsApp media into the
// project-local folder. Streamed (not buffered) so 50 MB videos don't sit in
// memory before the cap check finishes.
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Download a buffer-or-URL payload to `destPath`. Returns the on-disk size.
 *
 * Accepts three source shapes (in order of preference for the dispatcher):
 *   1. `{ buffer: Buffer }`   — already in memory (tests, in-process bots)
 *   2. `{ url: string }`      — HTTPS URL to fetch
 *   3. `{ stream: ReadableStream }` — pre-opened stream (rare)
 *
 * Throws `MediaError` on oversize, unsupported source, or HTTP failure.
 *
 * @param {{buffer?: Buffer, url?: string, stream?: any}} source
 * @param {string} destPath absolute file path
 * @param {number} maxBytes hard ceiling; abort + unlink on overflow
 * @param {typeof import("./_errors.js").MediaError} MediaError
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
export async function writeMediaToDisk(source, destPath, maxBytes, MediaError, opts = {}) {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

  // --- Buffer path (tests / small payloads / already-decoded media) --------
  if (source.buffer) {
    const buf = source.buffer;
    if (!Buffer.isBuffer(buf)) {
      throw new MediaError("download_failed", "source.buffer must be a Buffer");
    }
    if (buf.length > maxBytes) {
      throw new MediaError("too_large", `payload ${buf.length}B exceeds limit ${maxBytes}B`);
    }
    await fs.promises.writeFile(destPath, buf);
    return buf.length;
  }

  // --- Stream-from-URL path (real WhatsApp flow) ----------------------------
  if (source.url) {
    const fetchImpl = opts.fetchImpl ?? fetch;
    let res;
    try {
      res = await fetchImpl(source.url);
    } catch (err) {
      throw new MediaError("download_failed", `fetch(${source.url}) threw: ${err.message}`);
    }
    if (!res.ok) {
      throw new MediaError("download_failed", `GET ${source.url} returned ${res.status}`);
    }
    // Content-length short-circuit BEFORE opening the file (the cap check must
    // not leave a truncated 0-byte file behind on disk).
    const cl = Number(res.headers.get("content-length") ?? "0");
    if (cl > maxBytes) {
      throw new MediaError("too_large", `content-length ${cl} exceeds limit ${maxBytes}B`);
    }

    const fh = await fs.promises.open(destPath, "w");
    let total = 0;
    try {
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          // Already past the cap — close + unlink BEFORE throwing so we don't
          // leave a partial file the retention sweep will trip on later.
          await fh.close();
          await fs.promises.unlink(destPath).catch(() => {});
          throw new MediaError("too_large", `payload exceeded ${maxBytes}B mid-stream`);
        }
        await fh.write(value);
      }
    } finally {
      // If the try-block reached the natural end of the stream we still need
      // to close; if it threw we already closed above.
      try { await fh.close(); } catch {}
    }
    return total;
  }

  throw new MediaError("download_failed", "source must include buffer or url");
}
