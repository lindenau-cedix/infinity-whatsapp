// Unit tests for media/video.js — same structure as image.test.js.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { saveVideo } from "../media/video.js";
import { preprocessMessage } from "../media/index.js";
import { MediaError } from "../media/_errors.js";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "infmedia-vid-"));

test("video: mp4 happy path", async () => {
  const bytes = Buffer.from("ftypmp42");
  const res = await saveVideo(
    { id: "v1", mimeType: "video/mp4", body: bytes },
    { mediaDir: TMP_ROOT },
  );
  assert.equal(res.mime, "video/mp4");
  assert.match(res.path, /videos[\\/]\d+_v1\.mp4$/);
  assert.ok(fs.existsSync(res.path));
});

test("video: 3gp accepted", async () => {
  const res = await saveVideo(
    { id: "v2", mimeType: "video/3gpp", body: Buffer.from("x") },
    { mediaDir: TMP_ROOT },
  );
  assert.match(res.path, /\.3gp$/);
});

test("video: unsupported MIME → MediaError unsupported_mime", async () => {
  await assert.rejects(
    saveVideo({ id: "v3", mimeType: "video/avi", body: Buffer.from("x") }, { mediaDir: TMP_ROOT }),
    (err) => err instanceof MediaError && err.code === "unsupported_mime",
  );
});

test("video: oversize buffer → MediaError too_large and no file left behind", async () => {
  // 2 MiB body but cap 1 KiB
  const big = Buffer.alloc(2 * 1024 * 1024, 0);
  // Compute the destination saveVideo would write to (without running it).
  const dest = path.join(TMP_ROOT, "videos", `${Date.now()}_v4.mp4`);
  await assert.rejects(
    saveVideo(
      { id: "v4", mimeType: "video/mp4", body: big },
      { mediaDir: TMP_ROOT, maxBytes: 1024 },
    ),
    (err) => err instanceof MediaError && err.code === "too_large",
  );
  // The rejected path must NOT have left behind the message's intended file.
  assert.equal(fs.existsSync(dest), false, `expected no file at ${dest}`);
});

test("video: URL fetch respects content-length header", async () => {
  // Stub fetch returns 4 KiB but cap is 1 KiB → too_large.
  const big = Buffer.alloc(4096, 0xab);
  const stubFetch = async () =>
    new Response(big, { status: 200, headers: { "content-length": String(big.length) } });

  // Compute intended path first so we can assert cleanup.
  const before = Date.now();
  const dest = path.join(TMP_ROOT, "videos", `${before}_v5.mp4`);
  // Allow a 100ms clock window around `before`.
  await assert.rejects(
    saveVideo(
      { id: "v5", mimeType: "video/mp4", url: "https://example.test/big" },
      { mediaDir: TMP_ROOT, maxBytes: 1024, fetchImpl: stubFetch },
    ),
    (err) => err instanceof MediaError && err.code === "too_large",
  );
  // Find any v5 file that exists; it must not.
  const videosDir = path.join(TMP_ROOT, "videos");
  if (fs.existsSync(videosDir)) {
    for (const name of fs.readdirSync(videosDir)) {
      assert.equal(/_v5\.mp4$/.test(name), false, `no v5.mp4 file should exist, found ${name}`);
    }
  }
});

test("preprocessMessage (video): mediaPaths populated, voiceTranscript null", async () => {
  const enriched = await preprocessMessage(
    { id: "pp-vid", mimeType: "video/mp4", body: Buffer.from("ftypmp42") },
    { mediaDir: TMP_ROOT },
  );
  assert.equal(enriched.voiceTranscript, null);
  assert.equal(enriched.mediaPaths.length, 1);
  assert.match(enriched.mediaPaths[0], /videos[\\/]\d+_pp-vid\.mp4$/);
});

test.after(() => fs.rmSync(TMP_ROOT, { recursive: true, force: true }));
