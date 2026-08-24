// =============================================================================
// Voice-reply dispatcher.
//
// Combines two responsibilities that belong to the Voice & Media Engineer:
//   1. Recognize the German trigger prefix "Antworte sprachlich" (case-
//      insensitive, optional colon/whitespace) and strip it from the
//      prompt before it reaches the endpoint adapter.
//   2. After the adapter returns a text reply, decide whether the reply
//      should be sent as voice (TTS) or as text (fallback).
//
// Why this lives in the voice/media package: the inbound preprocessMessage
// strips the prefix BEFORE delegating to the endpoint; the outbound voice
// synthesis is exclusively ours. Putting them in one module keeps the trigger
// vocabulary in a single place.
//
// Pinned in `tests/dispatcher/voiceReply.test.js` so other agents don't drift
// the contract.
// =============================================================================

import { synthesizeVoice, FALLBACK_NOTICE } from "../../media/tts/elevenlabs.js";

/**
 * @typedef {Object} EgressReply
 * @property {string} text    Outbound text the dispatcher will send.
 * @property {{ path: string, mime: string }[]} media
 *                            Audio media to attach (voice replies).
 * @property {boolean} asVoice True if the reply should be sent as voice.
 * @property {boolean} fallback True if TTS failed and the text fallback was used.
 */

/**
 * Detect the German voice-reply prefix in a user prompt.
 *
 * Recognised forms (case-insensitive, leading whitespace allowed):
 *   "Antworte sprachlich: Hallo"      → { voiceReply: true, stripped: "Hallo" }
 *   "antworte sprachlich Was ist los?" → { voiceReply: true, stripped: "Was ist los?" }
 *
 * The optional colon is consumed together with whatever single separator
 * follows it (':' or whitespace). Anything not consumed is left in `stripped`.
 *
 * @param {string} prompt
 * @returns {{ voiceReply: boolean, stripped: string }}
 */
export function detectVoicePrefix(prompt) {
  const orig = typeof prompt === "string" ? prompt : "";
  // Trigger: optional leading ws + "antworte sprachlich" + optional ':'/
  // whitespace glue + the user message. We capture (and discard) the optional
  // ':' or single gluing separator so the returned body is the real prompt.
  const m = orig.match(/^\s*antworte\s+sprachlich(?:\s*:|\s+|:)([\s\S]*)$/i);
  if (m && m[1].trim().length > 0) {
    return { voiceReply: true, stripped: m[1].trim() };
  }
  return { voiceReply: false, stripped: orig };
}

export function stripVoicePrefix(prompt) {
  return detectVoicePrefix(prompt).stripped;
}

/**
 * Take a text reply, synthesize it with ElevenLabs, and produce an
 * EgressReply. On any TTS failure we fall back to the text reply with a
 * short notice so the user still sees *something*.
 *
 * @param {{ text: string }} reply   text reply from an `EndpointAdapter`
 * @param {{
 *   voiceId?: string,
 *   modelId?: string,
 *   mediaDir?: string,
 *   fetchImpl?: typeof fetch,
 *   apiKey?: string,
 *   synthesize?: typeof synthesizeVoice,  // tests can inject a stub
 *   log?: (event: string, fields?: Record<string,unknown>) => void,
 * }} [opts]
 * @returns {Promise<EgressReply>}
 */
export async function buildVoiceReply(reply, opts = {}) {
  const text = (reply && typeof reply.text === "string") ? reply.text : "";
  const log = opts.log ?? (() => {});
  const synth = opts.synthesize ?? synthesizeVoice;

  try {
    const audioPath = await synth(text, {
      apiKey: opts.apiKey,
      voiceId: opts.voiceId,
      modelId: opts.modelId,
      mediaDir: opts.mediaDir,
      fetchImpl: opts.fetchImpl,
      // Synthesizer logs `elevenlabs.synthesized` via the `(msg, fields)` shim;
      // we expose it back to the dispatcher's `log` consumer as an event-like
      // record (test asserts on `event === "elevenlabs.synthesized"`).
      log: (msg, fields) => log(msg, fields),
    });
    return {
      text: "",
      media: [{ path: audioPath, mime: "audio/mpeg" }],
      asVoice: true,
      fallback: false,
    };
  } catch (err) {
    log("voice.fallback", { error: err?.message ?? String(err) });
    return {
      text: `${FALLBACK_NOTICE} ${text}`.trim(),
      media: [],
      asVoice: false,
      fallback: true,
    };
  }
}
