// =============================================================================
// test/qwen.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run, resolveBinary, resolveModel } = require('../dispatcher/qwen.js');
const { fakeQwenCli, withEnv } = require('./helpers.js');

test('qwen: invokes CLI with -m <model> -p <prompt>', async () => {
  const fake = await fakeQwenCli({ reply: 'hello from qwen' });
  try {
    await withEnv({ QWEN_BIN: fake.binPath }, async () => {
      const text = await run('Summarize Kubernetes liveness probes', { group: 'Qwen' });
      assert.match(text, /hello from qwen/);
    });
  } finally {
    await fake.cleanup();
  }
});

test('qwen: respects ctx.qwenBin override', async () => {
  const fake = await fakeQwenCli({ reply: 'override ok' });
  try {
    const text = await run('test prompt', { qwenBin: fake.binPath });
    assert.match(text, /override ok/);
  } finally {
    await fake.cleanup();
  }
});

test('qwen: respects ctx.qwenModel override', async () => {
  const fake = await fakeQwenCli({ reply: 'custom model ok' });
  try {
    const text = await run('prompt', { qwenBin: fake.binPath, qwenModel: 'qwen3:30b-a3b-instruct' });
    assert.match(text, /custom model ok/);
  } finally {
    await fake.cleanup();
  }
});

test('qwen: default model is qwen3:30b-a3b', () => {
  assert.equal(resolveModel({}), 'qwen3:30b-a3b');
});

test('qwen: QWEN_MODEL env var wins when ctx is silent', async () => {
  const fake = await fakeQwenCli({ reply: 'env model ok' });
  try {
    await withEnv({ QWEN_BIN: fake.binPath, QWEN_MODEL: 'qwen3:7b' }, async () => {
      assert.equal(resolveModel({}), 'qwen3:7b');
      const text = await run('p', {});
      assert.match(text, /env model ok/);
    });
  } finally {
    await fake.cleanup();
  }
});

test('qwen: missing CLI binary throws a clear ENOENT-shaped error', async () => {
  await withEnv({ QWEN_BIN: '/nonexistent/qwen-binary-xyz' }, async () => {
    await assert.rejects(
      () => run('hi', {}),
      (err) => /qwen CLI not found/.test(err.message),
    );
  });
});

test('qwen: CLI failure surfaces stderr', async () => {
  const fake = await fakeQwenCli({ failure: 'model not found' });
  try {
    await withEnv({ QWEN_BIN: fake.binPath }, async () => {
      await assert.rejects(
        () => run('hi', {}),
        (err) => /exited with code 1/.test(err.message) && /model not found/.test(err.message),
      );
    });
  } finally {
    await fake.cleanup();
  }
});

test('qwen: empty reply from CLI throws', async () => {
  // Use a fake that writes nothing to stdout.
  const fake = await fakeQwenCli({ reply: '' });
  try {
    await withEnv({ QWEN_BIN: fake.binPath }, async () => {
      await assert.rejects(() => run('hi', {}), /empty reply/);
    });
  } finally {
    await fake.cleanup();
  }
});

test('qwen: non-string prompt throws TypeError', async () => {
  await assert.rejects(() => run(123, {}), TypeError);
});

test('qwen: resolveBinary falls back to "qwen"', () => {
  assert.equal(resolveBinary({}), 'qwen');
});