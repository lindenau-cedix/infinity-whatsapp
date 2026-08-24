// =============================================================================
// Folder layout helper.
//
// Everything Voice & Media owns lives under the project-local `media/` tree:
//   ./media/images/   <timestamp>_<id>.<ext>     (inbound images)
//   ./media/videos/   <timestamp>_<id>.<ext>     (inbound videos)
//   ./media/voice/    <timestamp>_<id>.<ext>     (inbound voice notes)
//   ./media/outbound/ <timestamp>_<id>.mp3       (ElevenLabs TTS output)
//
// A single entry point lets the WhatsApp Client Engineer override the root
// (`INFINITY_MEDIA_DIR`) and lets tests redirect to a tmp dir without monkey
// patching.
// =============================================================================

import * as path from "node:path";

/**
 * @param {string} [root] override the root. Defaults to `INFINITY_MEDIA_DIR`
 *   or `./media` (resolved against `process.cwd()`).
 */
export function resolveMediaRoot(root) {
  const raw = root ?? process.env.INFINITY_MEDIA_DIR ?? "./media";
  return path.resolve(process.cwd(), raw);
}

/** Convert "foo/bar/../baz" into an absolute path without a trailing slash. */
export function mediaDir(root, sub) {
  return path.join(resolveMediaRoot(root), sub);
}

/**
 * Build a media filename: `<unix_ms>_<id>.<ext>`.
 * Pass an explicit `ts` to make a path deterministic (tests, retention sweeps).
 */
export function mediaFilename(id, ext, ts = Date.now()) {
  const safeId = String(id ?? "anon").replace(/[^a-zA-Z0-9_.-]/g, "_");
  return `${ts}_${safeId}${ext.startsWith(".") ? ext : "." + ext}`;
}
