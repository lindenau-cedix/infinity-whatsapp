// =============================================================================
// Voice & Media barrel — the single import surface for the WhatsApp Client
// Engineer.
//
//   import { preprocessMessage } from "./media/index.js";
//   const enriched = await preprocessMessage(rawMessage);
//   // enriched = { promptText, mediaPaths, voiceTranscript }
//
// The dispatcher calls `preprocessMessage` BEFORE delegating to an
// `EndpointAdapter`. The returned shape matches `PromptContext.mediaPaths`
// from the Endpoints Integrator (`src/types.ts`) — same path-references
// contract, never base64.
// =============================================================================

import { saveImage } from "./image.js";
import { saveVideo } from "./video.js";
import { transcribeVoice, WHISPER_DEFAULT_MODEL } from "./voice.js";
import {
  IMAGE_MIME_TYPES,
  VIDEO_MIME_TYPES,
  VOICE_MIME_TYPES,
  IMAGE_MAX_BYTES,
  VIDEO_MAX_BYTES,
  VOICE_MAX_BYTES,
} from "./_constants.js";
import { MediaError } from "./_errors.js";

// --- re-exports for callers / tests -----------------------------------------

export { saveImage } from "./image.js";
export { saveVideo } from "./video.js";
export { transcribeVoice, WHISPER_DEFAULT_MODEL } from "./voice.js";
export { MediaError } from "./_errors.js";
export {
  IMAGE_MIME_TYPES,
  VIDEO_MIME_TYPES,
  VOICE_MIME_TYPES,
  IMAGE_MAX_BYTES,
  VIDEO_MAX_BYTES,
  VOICE_MAX_BYTES,
} from "./_constants.js";

// --- main API ---------------------------------------------------------------

/**
 * Decide whether `message` carries an image / video / voice payload based on
 * `mimeType`. Returns a discrimination string so the main entry point can
 * branch without re-parsing MIME strings.
 *
 * @param {{ mimeType?: string, type?: string }} message
 * @returns {"image"|"video"|"voice"|null}
 */
export function detectMediaKind(message) {
  const mime = String(message?.mimeType ?? message?.type ?? "").split(";")[0].trim();
  if (!mime) return null;
  if (IMAGE_MIME_TYPES[mime]) return "image";
  if (VIDEO_MIME_TYPES[mime]) return "video";
  if (VOICE_MIME_TYPES[mime]) return "voice";
  return null;
}

/**
 * The shape the WhatsApp Client Engineer hands us.
 *
 * @typedef {Object} RawWhatsAppMessage
 * @property {string} [id]            stable message id (used in filename)
 * @property {string} [mimeType]      e.g. `image/jpeg`, `audio/ogg; codecs=opus`
 * @property {string} [text]          body of a text message
 * @property {string} [caption]       image/video caption
 * @property {Buffer} [body]          pre-fetched media bytes (tests)
 * @property {string} [url]           HTTPS URL the WhatsApp client already opened
 * @property {string} [language]      BCP-47 hint for Whisper
 */

/**
 * Normalise an inbound WhatsApp message into the prompt envelope expected by
 * the Endpoints Integrator adapters.
 *
 * Behaviour:
 *   - Text-only message        → `promptText = text`, mediaPaths empty.
 *   - Image/video              → bytes saved to disk, absolute path added to
 *                                 `mediaPaths`. Caption (if any) is appended
 *                                 to the text body.
 *   - Voice                    → Whisper transcript becomes `promptText`,
 *                                 `voiceTranscript` is mirrored so downstream
 *                                 logging can show "from voice".
 *
 * The `opts` bag is forwarded to the underlying handlers so tests can stub
 * `apiKey` / `model` / `fetchImpl` without touching `process.env`.
 *
 * @param {RawWhatsAppMessage} rawMessage
 * @param {{
 *   mediaDir?: string,
 *   apiKey?: string,           // OPENAI_WHISPER_API_KEY (transcription only)
 *   model?: string,            // whisper-1 | gpt-4o-transcribe
 *   fetchImpl?: typeof fetch,  // test injection
 * }} [opts]
 * @returns {Promise<{ promptText: string, mediaPaths: string[], voiceTranscript: string | null }>}
 * @throws {MediaError}
 */
export async function preprocessMessage(rawMessage, opts = {}) {
  if (!rawMessage || typeof rawMessage !== "object") {
    throw new MediaError("missing_payload", "preprocessMessage: message is required");
  }

  const kind = detectMediaKind(rawMessage);

  // --- Text-only ----------------------------------------------------------
  if (!kind) {
    return {
      promptText: String(rawMessage.text ?? rawMessage.body ?? ""),
      mediaPaths: [],
      voiceTranscript: null,
    };
  }

  // --- Image --------------------------------------------------------------
  if (kind === "image") {
    const saved = await saveImage(rawMessage, { mediaDir: opts.mediaDir });
    const promptText = combineTextAndCaption(rawMessage, saved.path);
    return { promptText, mediaPaths: [saved.path], voiceTranscript: null };
  }

  // --- Video --------------------------------------------------------------
  if (kind === "video") {
    const saved = await saveVideo(rawMessage, { mediaDir: opts.mediaDir });
    const promptText = combineTextAndCaption(rawMessage, saved.path);
    return { promptText, mediaPaths: [saved.path], voiceTranscript: null };
  }

  // --- Voice (Whisper) ----------------------------------------------------
  if (kind === "voice") {
    const result = await transcribeVoice(rawMessage, {
      mediaDir: opts.mediaDir,
      apiKey: opts.apiKey,
      model: opts.model,
      fetchImpl: opts.fetchImpl,
    });
    const caption = rawMessage.caption ? `\n${rawMessage.caption}` : "";
    return {
      promptText: result.transcript + caption,
      mediaPaths: [result.path],
      voiceTranscript: result.transcript,
    };
  }

  // unreachable — detectMediaKind is total over the kind union
  throw new MediaError("missing_payload", "preprocessMessage: unrecognised media kind");
}

function combineTextAndCaption(message, mediaPath) {
  const lines = [];
  if (message.text) lines.push(String(message.text));
  if (message.caption) lines.push(`Caption: ${String(message.caption)}`);
  if (!lines.length) lines.push(`[attached ${path.basename(mediaPath)}]`);
  return lines.join("\n");
}

// node:path import moved here so the helper can use it without polluting
// module top-level imports for callers that never invoke image/video paths.
import * as path from "node:path";
