// =============================================================================
// Inbound voice handler.
//
// Flow:
//   1. Download the voice note to `./media/voice/<unix_ms>_<id>.ogg`.
//   2. POST the file to OpenAI Whisper (`whisper-1` by default; `gpt-4o-transcribe`
//      is a drop-in if a higher-quality model is requested).
//   3. Return the transcript text. The dispatcher treats that text as the
//      user's prompt — the original `voiceTranscript` field carries it too so
//      downstream logging can distinguish "voice-derived prompt" from typed
//      prompt.
//
// Failure surface: `MediaError` with code `transcribe_failed` if Whisper
// rejects the audio or returns an empty transcript. `MediaError` with code
// `too_large` if the payload exceeds the cap.
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { VOICE_MIME_TYPES, VOICE_MAX_BYTES } from "./_constants.js";
import { mediaDir, mediaFilename } from "./_paths.js";
import { writeMediaToDisk } from "./_download.js";
import { MediaError } from "./_errors.js";

/** Default transcription model. The task spec lists `whisper-1` and
 *  `gpt-4o-transcribe`; `whisper-1` is the conservative default. */
export const WHISPER_DEFAULT_MODEL = "whisper-1";

/** OpenAI audio-transcriptions endpoint. */
const WHISPER_URL = "https://api.openai.com/v1/audio/transcriptions";

/**
 * Save a voice note and transcribe it via OpenAI Whisper.
 *
 * @param {{ id: string, mimeType: string, body?: Buffer, url?: string, language?: string }} message
 * @param {{
 *   mediaDir?: string,
 *   apiKey?: string,
 *   model?: string,
 *   maxBytes?: number,
 *   fetchImpl?: typeof fetch,
 *   pollTranscribe?: boolean,
 * }} [opts]
 *
 *   - `apiKey` defaults to `process.env.OPENAI_WHISPER_API_KEY` (which the
 *     Endpoints Integrator's vault already validates).
 *   - `model` defaults to `whisper-1`. Pass `gpt-4o-transcribe` for a higher-
 *     quality result.
 *   - `fetchImpl` lets tests inject a stub.
 *
 * @returns {Promise<{ path: string, mime: string, transcript: string, model: string, bytes: number }>}
 * @throws {MediaError}
 */
export async function transcribeVoice(message, opts = {}) {
  if (!message || typeof message !== "object") {
    throw new MediaError("missing_payload", "transcribeVoice: message is required");
  }
  const { mimeType, id } = message;

  // Normalise the mime — WhatsApp often sends `audio/ogg; codecs=opus`.
  // Strip the codecs parameter for the allowlist lookup, keep it for filename.
  const baseMime = String(mimeType ?? "").split(";")[0].trim();
  const ext = VOICE_MIME_TYPES[mimeType] ?? VOICE_MIME_TYPES[baseMime];
  if (!ext) {
    throw new MediaError(
      "unsupported_mime",
      `transcribeVoice: mimeType ${mimeType ?? "<unset>"} is not supported (accept: ${Object.keys(VOICE_MIME_TYPES).join(", ")})`,
    );
  }

  const cap = opts.maxBytes ?? VOICE_MAX_BYTES;
  const dir = mediaDir(opts.mediaDir, "voice");
  const dest = path.join(dir, mediaFilename(id ?? "anon", ext));

  const bytes = await writeMediaToDisk(
    { buffer: message.body, url: message.url },
    dest,
    cap,
    MediaError,
  );

  const apiKey = opts.apiKey ?? process.env.OPENAI_WHISPER_API_KEY;
  if (!apiKey) {
    throw new MediaError(
      "transcribe_failed",
      "transcribeVoice: OPENAI_WHISPER_API_KEY is not set (issue one at https://platform.openai.com/api-keys)",
    );
  }
  const model = opts.model ?? WHISPER_DEFAULT_MODEL;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const transcript = await callWhisper({
    filePath: dest,
    mime: baseMime,
    model,
    apiKey,
    language: message.language,
    fetchImpl,
  });

  if (!transcript || transcript.trim().length === 0) {
    // Clean up the empty/transcript-less file — it has no value and just
    // clutters the retention sweep.
    await fs.promises.unlink(dest).catch(() => {});
    throw new MediaError("transcribe_failed", "Whisper returned an empty transcript");
  }

  return { path: dest, mime: baseMime, transcript, model, bytes };
}

// --- private ---------------------------------------------------------------

async function callWhisper({ filePath, mime, model, apiKey, language, fetchImpl }) {
  // Read once and ship as multipart. Voice notes are tiny (<25MB cap), so a
  // single memory load is fine — Whisper needs the raw bytes anyway.
  const data = await fs.promises.readFile(filePath);
  const blob = new Blob([data], { type: mime || "audio/ogg" });
  const form = new FormData();
  form.append("file", blob, path.basename(filePath));
  form.append("model", model);
  if (language) form.append("language", language);

  let res;
  try {
    res = await fetchImpl(WHISPER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (err) {
    throw new MediaError("transcribe_failed", `Whisper request threw: ${err.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new MediaError("transcribe_failed", `Whisper ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = await res.json().catch(() => ({}));
  const text = json.text ?? json.transcript;
  if (typeof text !== "string") {
    throw new MediaError("transcribe_failed", "Whisper response missing `text` field");
  }
  return text;
}
