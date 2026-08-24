// =============================================================================
// ElevenLabs text-to-speech client.
//
// Lives in `media/tts/` because the TTS output is outbound media; we follow
// the same "write to disk under INFINITY_MEDIA_DIR, hand back an absolute
// path" convention the inbound image/video handlers use (see _paths.js).
//
// The WhatsApp reply pipeline (owned by Integrator / Tech Lead) checks the
// German trigger prefix "Antworte sprachlich", strips it, runs the endpoint,
// then calls `synthesizeVoice(replyText)` and sends the resulting MP3 file
// back to the chat as a voice note. On any failure here the dispatcher falls
// back to sending the original text reply with a small notice (see
// `FALLBACK_NOTICE`) — the spec calls for the user-visible text reply to
// still arrive.
//
// Configuration (env, read once per call so tests can override):
//   ELEVENLABS_API_KEY   required
//   ELEVENLABS_VOICE_ID  optional — falls back to a sensible German voice
//   ELEVENLABS_MODEL_ID  optional — defaults to eleven_multilingual_v2
//
// API: https://elevenlabs.io/docs/api-reference/text-to-speech
//   POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}
//   Body: { text, model_id, voice_settings? }
//   Headers: xi-api-key, Content-Type: application/json, Accept: audio/mpeg
//   Response: audio/mpeg bytes.
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { mediaDir } from "../_paths.js";
import { MediaError } from "../_errors.js";

const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
const TTS_PATH = "/v1/text-to-speech/";

/**
 * Default German voice. ElevenLabs' public voice library exposes several
 * native-DE voices; "Daniel" (a multilingual DE/EN male) is the one chosen
 * here as a safe, broadly-licensed default. Operators can override via
 * `ELEVENLABS_VOICE_ID` in `.env`.
 */
export const DEFAULT_GERMAN_VOICE_ID = "onwK4e9ZLuTAKqWW03F9"; // Daniel

/** Default model. `eleven_multilingual_v2` ships with first-class German. */
export const DEFAULT_MODEL_ID = "eleven_multilingual_v2";

/** Notice prepended to the text reply if TTS fails. */
export const FALLBACK_NOTICE = "🔇 [voice fallback]";

/** Hard cap on the MP3 we will buffer in memory. */
const MAX_TTS_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * @typedef {Object} SynthesizeOptions
 * @property {string} [voiceId]    Override the voice ID (defaults to ELEVENLABS_VOICE_ID or DEFAULT_GERMAN_VOICE_ID).
 * @property {string} [modelId]    Override the model ID (defaults to ELEVENLABS_MODEL_ID or DEFAULT_MODEL_ID).
 * @property {string} [mediaDir]   Override the media root (used by tests via tmp dirs).
 * @property {typeof fetch} [fetchImpl]  Override the fetch impl (tests). Must match global `fetch`'s shape.
 * @property {string} [apiKey]     Override the API key (tests); defaults to ELEVENLABS_API_KEY.
 * @property {(msg: string, fields?: Record<string, unknown>) => void} [log]
 *           Optional logger — kept dependency-free so the integrator can inject one.
 */

/**
 * Synthesize `text` to speech via ElevenLabs and write the resulting MP3 to
 * `./media/tts/<timestamp>.mp3`. Returns the absolute path.
 *
 * Throws `MediaError` with `code === "tts_failed"` on any upstream failure;
 * the caller (the integrator's reply dispatcher) is expected to catch and
 * fall back to sending the original text reply.
 *
 * @param {string} text
 * @param {SynthesizeOptions} [opts]
 * @returns {Promise<string>} absolute path to the MP3 file on disk
 */
export async function synthesizeVoice(
  text,
  opts = {},
) {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new MediaError(
      "missing_payload",
      "synthesizeVoice: text is required and must be a non-empty string",
    );
  }

  const apiKey = opts.apiKey ?? process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new MediaError(
      "tts_failed",
      "synthesizeVoice: ELEVENLABS_API_KEY is not set",
    );
  }

  const voiceId =
    opts.voiceId ?? process.env.ELEVENLABS_VOICE_ID ?? DEFAULT_GERMAN_VOICE_ID;
  const modelId =
    opts.modelId ?? process.env.ELEVENLABS_MODEL_ID ?? DEFAULT_MODEL_ID;

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new MediaError(
      "tts_failed",
      "synthesizeVoice: no fetch implementation available (Node 18+ required)",
    );
  }

  const url = `${ELEVENLABS_BASE_URL}${TTS_PATH}${encodeURIComponent(voiceId)}`;
  const body = {
    text,
    model_id: modelId,
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75,
    },
  };

  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new MediaError(
      "tts_failed",
      `synthesizeVoice: fetch threw (${err?.message ?? err})`,
    );
  }

  if (!res.ok) {
    let upstream = "";
    try {
      upstream = (await res.text()).slice(0, 200);
    } catch {
      // Body may not be text; that's fine.
    }
    throw new MediaError(
      "tts_failed",
      `synthesizeVoice: ElevenLabs returned HTTP ${res.status} — ${upstream}`,
    );
  }

  // --- Stream the audio bytes to disk -------------------------------------
  const dir = mediaDir(opts.mediaDir, "tts");
  await fs.promises.mkdir(dir, { recursive: true });
  const dest = path.join(dir, `${Date.now()}.mp3`);

  const arrayBuf = await res.arrayBuffer();
  const bytes = Buffer.from(arrayBuf);
  if (bytes.length === 0) {
    throw new MediaError("tts_failed", "synthesizeVoice: empty audio response");
  }
  if (bytes.length > MAX_TTS_BYTES) {
    throw new MediaError(
      "tts_failed",
      `synthesizeVoice: audio response ${bytes.length}B exceeds limit ${MAX_TTS_BYTES}B`,
    );
  }
  await fs.promises.writeFile(dest, bytes);

  opts.log?.("elevenlabs.synthesized", {
    voice_id: voiceId,
    model_id: modelId,
    bytes: bytes.length,
    path: dest,
  });

  return dest;
}
