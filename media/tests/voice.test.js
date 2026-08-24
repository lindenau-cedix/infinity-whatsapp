// Unit tests for media/voice.js — exercises happy path (with a stubbed
// `fetchImpl`), unsupported MIME rejection, missing API key, and the empty
// transcript cleanup path. Also exercises the barrel-level
// preprocessMessage()→voice branch.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { transcribeVoice } from "../media/voice.js";
import { preprocessMessage } from "../media/index.js";
import { MediaError } from "../media/_errors.js";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "infmedia-vox-"));

/** Build a stub fetch that returns the canned Whisper response. */
function stubWhisper(transcript, { status = 200, bodyText = "" } = {}) {
  return async (url, init) => {
    if (!url.startsWith("https://api.openai.com/v1/audio/transcriptions")) {
      throw new Error(`unexpected URL: ${url}`);
    }
    return new Response(
      status === 200 ? JSON.stringify({ text: transcript }) : bodyText,
      { status, headers: { "content-type": "application/json" } },
    );
  };
}

test("voice: happy path — file saved, transcript returned", async () => {
  const bytes = Buffer.from("OggS\x00\x02"); // faux ogg-ish
  const fetchImpl = stubWhisper("hello there from voice");
  const res = await transcribeVoice(
    { id: "v1", mimeType: "audio/ogg; codecs=opus", body: bytes },
    { mediaDir: TMP_ROOT, apiKey: "test-key", fetchImpl },
  );
  assert.equal(res.transcript, "hello there from voice");
  assert.equal(res.mime, "audio/ogg");
  assert.match(res.path, /voice[\\/]\d+_v1\.ogg$/);
  assert.ok(fs.existsSync(res.path));
});

test("voice: opg, mp3, m4a, wav all accepted", async () => {
  const fetchImpl = stubWhisper("ok");
  for (const [mime, ext] of [
    ["audio/ogg; codecs=opus", ".ogg"],
    ["audio/opus", ".ogg"],
    ["audio/mpeg", ".mp3"],
    ["audio/mp4", ".m4a"],
    ["audio/x-m4a", ".m4a"],
    ["audio/wav", ".wav"],
  ]) {
    const r = await transcribeVoice(
      { id: `id-${ext}`, mimeType: mime, body: Buffer.from("x") },
      { mediaDir: TMP_ROOT, apiKey: "k", fetchImpl },
    );
    assert.match(r.path, new RegExp(`${ext.replace(".", "\\.")}$`));
  }
});

test("voice: unsupported MIME → MediaError unsupported_mime", async () => {
  await assert.rejects(
    transcribeVoice(
      { id: "v2", mimeType: "audio/flac", body: Buffer.from("x") },
      { mediaDir: TMP_ROOT, apiKey: "k", fetchImpl: stubWhisper("unused") },
    ),
    (err) => err instanceof MediaError && err.code === "unsupported_mime",
  );
});

test("voice: missing apiKey → MediaError transcribe_failed (no Whisper call)", async () => {
  // Use a fetchImpl that throws to make sure we never reach it.
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error("should not be called"); };
  const origKey = process.env.OPENAI_WHISPER_API_KEY;
  delete process.env.OPENAI_WHISPER_API_KEY;
  try {
    await assert.rejects(
      transcribeVoice(
        { id: "v3", mimeType: "audio/ogg", body: Buffer.from("x") },
        { mediaDir: TMP_ROOT, fetchImpl },
      ),
      (err) => err instanceof MediaError && err.code === "transcribe_failed",
    );
  } finally {
    if (origKey) process.env.OPENAI_WHISPER_API_KEY = origKey;
    assert.equal(called, false, "fetchImpl must not be invoked when apiKey is missing");
  }
});

test("voice: empty transcript → MediaError transcribe_failed, file removed", async () => {
  const fetchImpl = stubWhisper("");
  // Compute the destination so we can assert THIS file (not the whole dir)
  // is unlinked.
  const stamp = Date.now();
  const intendedPath = path.join(TMP_ROOT, "voice", `${stamp}_v4.ogg`);
  await assert.rejects(
    transcribeVoice(
      { id: "v4", mimeType: "audio/ogg", body: Buffer.from("x") },
      { mediaDir: TMP_ROOT, apiKey: "k", fetchImpl },
    ),
    (err) => err instanceof MediaError && err.code === "transcribe_failed",
  );
  assert.equal(fs.existsSync(intendedPath), false, "voice file must be unlinked on empty transcript");
});

test("voice: Whisper 500 → MediaError transcribe_failed (passes through body excerpt)", async () => {
  const fetchImpl = stubWhisper("", { status: 500, bodyText: "internal server error\nstack..." });
  await assert.rejects(
    transcribeVoice(
      { id: "v5", mimeType: "audio/ogg", body: Buffer.from("x") },
      { mediaDir: TMP_ROOT, apiKey: "k", fetchImpl },
    ),
    (err) => err instanceof MediaError && err.code === "transcribe_failed"
      && /Whisper 500/.test(err.message),
  );
});

test("preprocessMessage (voice): transcript becomes promptText, voiceTranscript mirrored", async () => {
  const fetchImpl = stubWhisper("transcribed text");
  const enriched = await preprocessMessage(
    { id: "pp-vox", mimeType: "audio/ogg; codecs=opus", body: Buffer.from("x"), caption: "what?" },
    { mediaDir: TMP_ROOT, apiKey: "k", fetchImpl },
  );
  assert.equal(enriched.voiceTranscript, "transcribed text");
  assert.equal(enriched.promptText, "transcribed text\nwhat?");
  assert.equal(enriched.mediaPaths.length, 1);
  assert.match(enriched.mediaPaths[0], /voice[\\/]\d+_pp-vox\.ogg$/);
});

test.after(() => fs.rmSync(TMP_ROOT, { recursive: true, force: true }));
