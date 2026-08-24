// =============================================================================
// Reply dispatcher — voice reply branch.
//
// When an inbound message carries the German trigger "Antworte sprachlich"
// (already stripped from `message.text` and exposed as `message.voiceReply`
// by the WhatsApp client), we:
//   1. Take the endpoint's text reply.
//   2. Ask ElevenLabs (`infinity-media/media/tts/elevenlabs`) to render it.
//   3. Hand the dispatcher back an `EgressReply` whose `media[0]` is the
//      rendered MP3 path and whose `text` is empty (so WhatsApp sends a
//      voice note, not a duplicate text bubble).
//
// Failure mode (the spec calls for graceful fallback): if `synthesizeVoice`
// throws `MediaError`, we send the original text reply back, prefixed with
// `🔇 [voice fallback]` so the user knows the audio leg failed. We log
// `voice.fallback` so the integration test (INFA-4) can see it.
//
// The trigger prefix detection lives in the WhatsApp client
// (`d1a31c3e`/triggers.ts). We re-check the flag here defensively — that way
// a future transport (WhatsApp Business Cloud API) can also drive this branch
// without re-implementing the prefix logic.
//
// This module deliberately depends on:
//   - infinity-media/media/tts/elevenlabs.js   (TTS)
//   - types from the Endpoints Integrator      (EndpointAdapter, Reply)
//   - types from the WhatsApp transport        (IngressMessage, EgressReply)
// It does NOT import whatsapp-web.js, the credential vault, or any single
// provider's adapter.
// =============================================================================

import { synthesizeVoice, FALLBACK_NOTICE } from "../tts/elevenlabs.js";

/**
 * Compose the reply for a message that came in with the voice-reply trigger.
 *
 * @param {import("../src/types.js").Reply} endpointReply the text reply from the chosen adapter
 * @param {{
 *   voiceId?: string,
 *   modelId?: string,
 *   mediaDir?: string,
 *   log?: (event: string, fields?: Record<string, unknown>) => void,
 * }} [opts]
 * @returns {Promise<{
 *   text: string,
 *   media: Array<{ path: string, mime: string, kind: "audio" }>,
 *   asVoice: boolean,
 *   fallback: boolean,
 * }>}
 */
export async function buildVoiceReply(endpointReply, opts = {}) {
  const replyText = endpointReply?.text ?? "";

  try {
    const audioPath = await synthesizeVoice(replyText, {
      voiceId: opts.voiceId,
      modelId: opts.modelId,
      mediaDir: opts.mediaDir,
      log: opts.log,
    });
    opts.log?.("voice.reply.sent", { path: audioPath, bytes: undefined });
    return {
      text: "",
      media: [{ path: audioPath, mime: "audio/mpeg", kind: "audio" }],
      asVoice: true,
      fallback: false,
    };
  } catch (err) {
    opts.log?.("voice.fallback", {
      reason: err?.message ?? String(err),
      code: err?.code,
    });
    return {
      text: `${FALLBACK_NOTICE} ${replyText}`,
      media: [],
      asVoice: false,
      fallback: true,
    };
  }
}

/**
 * Defensive re-check of the trigger prefix. The WhatsApp client already
 * strips it, but the dispatcher accepts arbitrary `IngressMessage` shapes
 * (test fixtures, future transports) — if `voiceReply` is false but the body
 * still begins with the trigger, we surface it here rather than letting the
 * audio include the trigger phrase verbatim.
 *
 * @param {string} rawBody the message body exactly as received from the transport
 * @returns {{ voiceReply: boolean, stripped: string }}
 */
export function detectVoicePrefix(rawBody) {
  const VOICE_PREFIX = "Antworte sprachlich";
  const trimmed = (rawBody ?? "").replace(/^\s+/, "");
  if (trimmed.toLowerCase().startsWith(VOICE_PREFIX.toLowerCase())) {
    return {
      voiceReply: true,
      stripped: trimmed.slice(VOICE_PREFIX.length).trim(),
    };
  }
  return { voiceReply: false, stripped: trimmed };
}
