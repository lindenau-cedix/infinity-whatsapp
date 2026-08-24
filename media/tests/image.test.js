// Unit tests for media/image.js + media/index.js (image branch).
// Uses node:test + node:assert only — no external deps.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { saveImage } from "../media/image.js";
import { preprocessMessage } from "../media/index.js";
import { MediaError } from "../media/_errors.js";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "infmedia-img-"));
function cleanup() {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
}

test("image: happy path — buffer saved with correct extension", async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG SOI
  const res = await saveImage(
    { id: "abc123", mimeType: "image/jpeg", body: bytes },
    { mediaDir: TMP_ROOT },
  );
  assert.equal(res.mime, "image/jpeg");
  assert.equal(res.bytes, bytes.length);
  assert.match(res.path, /images[\\/]\d+_abc123\.jpg$/);
  assert.ok(fs.existsSync(res.path), "file written to disk");
});

test("image: png, webp, gif, heic variants all accepted", async () => {
  for (const [mime, ext] of [
    ["image/png", ".png"],
    ["image/webp", ".webp"],
    ["image/gif", ".gif"],
    ["image/heic", ".heic"],
  ]) {
    const res = await saveImage(
      { id: `id-${mime}`, mimeType: mime, body: Buffer.from("x") },
      { mediaDir: TMP_ROOT },
    );
    assert.match(res.path, new RegExp(`${ext.replace(".", "\\.")}$`));
  }
});

test("image: unsupported MIME → MediaError unsupported_mime", async () => {
  await assert.rejects(
    saveImage({ id: "x", mimeType: "image/bmp", body: Buffer.from("x") }, { mediaDir: TMP_ROOT }),
    (err) => err instanceof MediaError && err.code === "unsupported_mime",
  );
});

test("image: missing message → MediaError missing_payload", async () => {
  await assert.rejects(
    saveImage(null, { mediaDir: TMP_ROOT }),
    (err) => err instanceof MediaError && err.code === "missing_payload",
  );
});

test("image: URL source is fetched and streamed to disk", async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG signature
  let fetchedUrl = null;
  const stubFetch = async (url) => {
    fetchedUrl = url;
    return new Response(bytes, {
      status: 200,
      headers: { "content-type": "image/png", "content-length": String(bytes.length) },
    });
  };
  const res = await saveImage(
    { id: "net", mimeType: "image/png", url: "https://example.test/img" },
    { mediaDir: TMP_ROOT, fetchImpl: stubFetch },
  );
  assert.equal(fetchedUrl, "https://example.test/img");
  assert.equal(res.bytes, bytes.length);
  assert.match(res.path, /images[\\/]\d+_net\.png$/);
  assert.deepEqual(fs.readFileSync(res.path), bytes);
});

test("preprocessMessage (image): adds path to mediaPaths, leaves voiceTranscript null", async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const enriched = await preprocessMessage(
    { id: "pp-img", mimeType: "image/jpeg", body: bytes, caption: "look at this" },
    { mediaDir: TMP_ROOT },
  );
  assert.equal(enriched.voiceTranscript, null);
  assert.equal(enriched.mediaPaths.length, 1);
  assert.match(enriched.mediaPaths[0], /images[\\/]\d+_pp-img\.jpg$/);
  assert.match(enriched.promptText, /Caption: look at this/);
});

test("preprocessMessage (text): passes through, no mediaPaths", async () => {
  const enriched = await preprocessMessage({ text: "hello world" }, { mediaDir: TMP_ROOT });
  assert.equal(enriched.promptText, "hello world");
  assert.deepEqual(enriched.mediaPaths, []);
  assert.equal(enriched.voiceTranscript, null);
});

test.after(cleanup);
