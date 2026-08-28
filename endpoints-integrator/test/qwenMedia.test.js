// =============================================================================
// test/qwenMedia.test.js
//
// INFA-27 — Qwen media analyser dispatcher. Drives `dispatcher/qwenMedia.js`
// against a fake qwen CLI (same approach as test/qwen.test.js) and asserts
// the CLI receives the exact `-m <model> -p "Analyse this media: [PATH]"`
// argv the issue specifies.
//
// Also verifies register.js routes the WA-side `qwenCode` adapter through
// the analyser whenever `ctx.mediaPaths` is non-empty, and falls back to
// the plain text path otherwise.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  run,
  buildPrompt,
  resolveBinary,
  resolveModel,
  DEFAULT_MODEL,
} = require('../dispatcher/qwenMedia.js');
const {
  shouldRouteToMediaAnalyser,
} = require('../register.js');
const { fakeQwenCli, withEnv } = require('./helpers.js');

test('qwen-media: invokes qwen with the literal "Analyse this media: [PATH]" prompt', async () => {
  // Capture the argv the analyser actually sends. The fake CLI echoes it
  // back so we can assert both `-m` and `-p` content verbatim.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const captureDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'qwen-media-argv-'));
  const captureFile = path.join(captureDir, 'argv.json');
  // Build a fake `qwen` that writes its argv to a JSON file and echoes a
  // canned reply. argv layout: [bin, -m, model, -p, prompt] — we extract
  // model from $2 and prompt from $4 (the latter is what the issue spec
  // prescribes verbatim).
  const fakeBin = path.join(captureDir, 'qwen');
  const script = [
    '#!/bin/sh',
    'echo "{\\"model\\":\\"$2\\",\\"prompt\\":\\"$4\\"}" > "' + captureFile + '"',
    'echo "I see the image"',
  ].join('\n');
  await fs.promises.writeFile(fakeBin, script, { mode: 0o755 });

  try {
    const reply = await run(['/tmp/media/photo.jpg'], {
      qwenBin: fakeBin,
      qwenModel: 'qwen3:30b-a3b',
    });
    assert.match(reply, /I see the image/);
    const argv = JSON.parse(await fs.promises.readFile(captureFile, 'utf8'));
    assert.equal(argv.model, 'qwen3:30b-a3b');
    assert.match(argv.prompt, /^Analyse this media: \[\/tmp\/media\/photo\.jpg\]$/);
  } finally {
    await fs.promises.rm(captureDir, { recursive: true, force: true });
  }
});

test('qwen-media: default model is qwen3:30b-a3b', () => {
  assert.equal(resolveModel({}), 'qwen3:30b-a3b');
  assert.equal(resolveModel({ qwenModel: 'qwen3:7b' }), 'qwen3:7b');
  assert.equal(resolveModel({}), DEFAULT_MODEL);
});

test('qwen-media: QWEN_MODEL env var wins when ctx is silent', async () => {
  // We override the model, not the binary — happy path catches the env override.
  const fake = await fakeQwenCli({ reply: 'env ok' });
  try {
    await withEnv({ QWEN_BIN: fake.binPath, QWEN_MODEL: 'qwen3:7b' }, async () => {
      assert.equal(resolveModel({}), 'qwen3:7b');
      const reply = await run(['/tmp/x.jpg'], {});
      assert.match(reply, /env ok/);
    });
  } finally {
    await fake.cleanup();
  }
});

test('qwen-media: empty mediaPaths throws TypeError', async () => {
  await assert.rejects(() => run([], {}), TypeError);
  await assert.rejects(() => run(undefined, {}), TypeError);
  await assert.rejects(() => run(null, {}), TypeError);
});

test('qwen-media: appends additional paths as context note', () => {
  const prompt = buildPrompt(['/a/1.jpg', '/a/2.jpg', '/a/3.jpg']);
  // Strict issue-spec format: `Analyse this media: [/a/1.jpg]`
  assert.match(prompt, /^Analyse this media: \[\/a\/1\.jpg\]/);
  assert.match(prompt, /Additional saved attachments/);
  assert.match(prompt, /\/a\/2\.jpg/);
  assert.match(prompt, /\/a\/3\.jpg/);
});

test('qwen-media: missing CLI binary throws a clear ENOENT-shaped error', async () => {
  await withEnv({ QWEN_BIN: '/nonexistent/qwen-binary-xyz' }, async () => {
    await assert.rejects(
      () => run(['/tmp/x.jpg'], {}),
      /qwen CLI not found/,
    );
  });
});

test('qwen-media: CLI failure surfaces stderr', async () => {
  const fake = await fakeQwenCli({ failure: 'model not found' });
  try {
    await withEnv({ QWEN_BIN: fake.binPath }, async () => {
      await assert.rejects(
        () => run(['/tmp/x.jpg'], {}),
        (err) =>
          /exited with code 1/.test(err.message) &&
          /model not found/.test(err.message),
      );
    });
  } finally {
    await fake.cleanup();
  }
});

test('qwen-media: empty reply from CLI throws', async () => {
  const fake = await fakeQwenCli({ reply: '' });
  try {
    await withEnv({ QWEN_BIN: fake.binPath }, async () => {
      await assert.rejects(() => run(['/tmp/x.jpg'], {}), /empty reply/);
    });
  } finally {
    await fake.cleanup();
  }
});

test('register.js: qwenCode routes to media analyser when ctx.mediaPaths is non-empty', () => {
  assert.equal(
    shouldRouteToMediaAnalyser('qwenCode', 'caption text', { mediaPaths: ['/m/x.jpg'] }),
    true,
  );
  // Even an empty prompt goes through the analyser branch as long as a path
  // exists — captions are optional on WhatsApp image sends.
  assert.equal(
    shouldRouteToMediaAnalyser('qwenCode', '', { mediaPaths: ['/m/x.mp4'] }),
    true,
  );
});

test('register.js: qwenCode skips the media branch when ctx.mediaPaths is empty', () => {
  assert.equal(
    shouldRouteToMediaAnalyser('qwenCode', 'plain text', { mediaPaths: [] }),
    false,
  );
  assert.equal(
    shouldRouteToMediaAnalyser('qwenCode', 'plain text', {}),
    false,
  );
  assert.equal(
    shouldRouteToMediaAnalyser('qwenCode', 'plain text', { mediaPaths: undefined }),
    false,
  );
});

test('register.js: non-Qwen endpoints never route to the media analyser', () => {
  // Other adapters have their own media story (or none at all); this
  // guard makes the change visible in case someone adds a sibling branch.
  for (const name of [
    'perplexityReasoning',
    'perplexityDeepResearch',
    'firecrawl',
  ]) {
    assert.equal(
      shouldRouteToMediaAnalyser(name, 'hi', { mediaPaths: ['/x.jpg'] }),
      false,
    );
  }
});
