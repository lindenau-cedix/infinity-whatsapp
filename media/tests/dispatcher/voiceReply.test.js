// =============================================================================
// Voice-reply dispatcher tests.
//
// Two paths:
//   1. Synthesize succeeds  → EgressReply.media[0] is the audio file,
//      text is empty, asVoice: true.
//   2. Synthesize fails      → EgressReply.text carries the original text
//      with the FALLBACK_NOTICE prepended, media is empty, asVoice: false,
//      fallback: true.
//
// We exercise the dispatcher with a stubbed `synthesizeVoice` so the test
// does not need a live ElevenLabs account or any env wiring.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

import { buildVoiceReply, detectVoicePrefix } from "../../media/dispatcher/voiceReply.js";

// ---------- stubs ----------------------------------------------------------

function fakeSynthOk(audioPath) {
  return async () => audioPath;
}

function fakeSynthFail(err) {
  return async () => {
    throw err;
  };
}

// ---------- prefix detection ----------------------------------------------

test("detectVoicePrefix: matches case-insensitively after leading whitespace", () => {
  assert.deepEqual(detectVoicePrefix("Antworte sprachlich: Hallo"), {
    voiceReply: true,
    stripped: ": Hallo",
  });
  assert.deepEqual(detectVoicePrefix("antworte sprachlich Was gibt's?"), {
    voiceReply: true,
    stripped: "Was gibt's?",
  });
  assert.deepEqual(detectVoicePrefix("   Antwort sprachlich"), {
    voiceReply: false,
    stripped: "Antwort sprachlich",
  });
});

// ---------- success path ---------------------------------------------------

test("buildVoiceReply: returns audio media + empty text when TTS succeeds", async () => {
  // Re-import the module with a stubbed synthesizeVoice by patching module
  // exports via the in-test dynamic import is not supported; instead we
  // inject the dependency through opts once the dispatcher exposes it. Until
  // then, we drive the dispatcher with a real network-less fetchImpl via a
  // tiny shim: synthesizeVoice's fetchImpl is global, so we monkey-patch.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(Buffer.from("FAKE-MP3-BYTES"), {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    });
  process.env.ELEVENLABS_API_KEY = "test-key";
  delete process.env.ELEVENLABS_VOICE_ID;
  delete process.env.ELEVENLABS_MODEL_ID;

  try {
    const events = [];
    const log = (event, fields) => events.push({ event, ...(fields ?? {}) });
    const reply = { text: "Guten Tag, alles klar." };
    const out = await buildVoiceReply(reply, {
      voiceId: "voice-abc",
      modelId: "eleven_multilingual_v2",
      mediaDir: ".tmp-voice-success",
      log,
    });

    assert.equal(out.fallback, false);
    assert.equal(out.asVoice, true);
    assert.equal(out.text, "");
    assert.equal(out.media.length, 1);
    assert.match(out.media[0].path, /\.mp3$/);
    assert.equal(out.media[0].mime, "audio/mpeg");
    assert.ok(events.some((e) => e.event === "elevenlabs.synthesized"));
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(".tmp-voice-success", { recursive: true, force: true });
  }
});

// ---------- fallback path --------------------------------------------------

test("buildVoiceReply: falls back to text with notice when TTS throws", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("ECONNREFUSED 127.0.0.1:443");
  };
  process.env.ELEVENLABS_API_KEY = "test-key";

  try {
    const events = [];
    const log = (event, fields) => events.push({ event, ...(fields ?? {}) });
    const reply = { text: "Guten Tag, alles klar." };
    const out = await buildVoiceReply(reply, {
      voiceId: "voice-abc",
      modelId: "eleven_multilingual_v2",
      mediaDir: ".tmp-voice-fallback",
      log,
    });

    assert.equal(out.fallback, true);
    assert.equal(out.asVoice, false);
    assert.equal(out.media.length, 0);
    assert.match(out.text, /^🔇 \[voice fallback\]/);
    assert.ok(out.text.includes("Guten Tag, alles klar."));
    assert.ok(events.some((e) => e.event === "voice.fallback"));
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(".tmp-voice-fallback", { recursive: true, force: true });
  }
});

// Late import for fs so the imports above don't get tangled.
// (fs is now imported at the top.)
