// Barrel-level tests for media/index.js (detectMediaKind + preprocessMessage
// dispatch).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { detectMediaKind, preprocessMessage } from "../media/index.js";
import { MediaError } from "../media/index.js";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "infmedia-idx-"));

test("detectMediaKind routes by mime", () => {
  assert.equal(detectMediaKind({ mimeType: "image/jpeg" }), "image");
  assert.equal(detectMediaKind({ mimeType: "video/mp4" }), "video");
  assert.equal(detectMediaKind({ mimeType: "audio/ogg; codecs=opus" }), "voice");
  assert.equal(detectMediaKind({ mimeType: "application/pdf" }), null);
  assert.equal(detectMediaKind({}), null);
});

test("preprocessMessage: missing message → MediaError missing_payload", async () => {
  await assert.rejects(
    preprocessMessage(null, { mediaDir: TMP_ROOT }),
    (err) => err instanceof MediaError && err.code === "missing_payload",
  );
});

test("preprocessMessage: empty text message yields empty promptText (don't crash)", async () => {
  const enriched = await preprocessMessage({}, { mediaDir: TMP_ROOT });
  assert.equal(enriched.promptText, "");
  assert.deepEqual(enriched.mediaPaths, []);
  assert.equal(enriched.voiceTranscript, null);
});

test.after(() => fs.rmSync(TMP_ROOT, { recursive: true, force: true }));
