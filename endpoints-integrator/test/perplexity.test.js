// =============================================================================
// test/perplexity.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const real = require('../dispatcher/perplexity.js');
const { fakeFetch, okJson, withEnv } = require('./helpers.js');

const URL = 'https://api.perplexity.ai/chat/completions';

test('perplexity: successful reasoning call returns message content', async () => {
  await withEnv({ PERPLEXITY_API_KEY: 'pplx-test' }, async () => {
    let capturedUrl, capturedInit;
    const restore = fakeFetch({
      [URL]: (init) => {
        capturedUrl = URL;
        capturedInit = init;
        return okJson({
          choices: [{ message: { content: 'The difference between TCP and UDP is…', reasoning: 'thinking…' } }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        });
      },
    });
    try {
      const text = await real.run('What is the difference between TCP and UDP?', {
        model: 'sonar-reasoning-pro',
        requestId: 'req-1',
      });
      assert.match(text, /TCP and UDP/);
      // Reasoning MUST NOT leak into the outbound text.
      assert.doesNotMatch(text, /thinking/);
      // Verify the request shape.
      assert.equal(capturedUrl, URL);
      assert.equal(capturedInit.method, 'POST');
      assert.equal(capturedInit.headers.Authorization, 'Bearer pplx-test');
      const body = JSON.parse(capturedInit.body);
      assert.equal(body.model, 'sonar-reasoning-pro');
      assert.deepEqual(body.messages, [{ role: 'user', content: 'What is the difference between TCP and UDP?' }]);
    } finally {
      restore();
    }
  });
});

test('perplexity: missing api key returns a friendly stub (INFA-20)', async () => {
  await withEnv({ PERPLEXITY_API_KEY: '' }, async () => {
    // INFA-20 contract change: instead of bubbling an AuthError that the
    // dispatcher turns into an opaque "Fehler bei …" reply, the adapter
    // returns a localized stub so the operator sees something useful
    // immediately and knows exactly which key to set.
    const text = await real.run('hello', { model: 'sonar-reasoning-pro' });
    assert.match(text, /Perplexity/i);
    assert.match(text, /PERPLEXITY_API_KEY/);
    assert.match(text, /Stub/i);
  });
});

test('perplexity: ctx.apiKey is honored even when env key is missing', async () => {
  await withEnv({ PERPLEXITY_API_KEY: '' }, async () => {
    // Passing apiKey through ctx must still route to a live call, never
    // hit the missing-key stub. INFA-20 only short-circuits when both
    // ctx.apiKey and the env var are absent.
    const restore = fakeFetch({
      [URL]: () => okJson({ choices: [{ message: { content: 'ctx-key-ok' } }] }),
    });
    try {
      const text = await real.run('hello', {
        model: 'sonar-reasoning-pro',
        apiKey: 'ctx-supplied-key',
      });
      assert.equal(text, 'ctx-key-ok');
    } finally {
      restore();
    }
  });
});

test('perplexity: ctx.apiKey overrides env var', async () => {
  let captured;
  const restore = fakeFetch({
    [URL]: (init) => {
      captured = init;
      return okJson({ choices: [{ message: { content: 'ok' } }] });
    },
  });
  try {
    const text = await real.run('hi', { model: 'sonar-reasoning-pro', apiKey: 'override-key' });
    assert.match(text, /ok/);
    assert.equal(captured.headers.Authorization, 'Bearer override-key');
  } finally {
    restore();
  }
});

test('perplexity: 401 surfaces a clear auth-rejection message', async () => {
  await withEnv({ PERPLEXITY_API_KEY: 'bad-key' }, async () => {
    const restore = fakeFetch({ [URL]: () => okJson({ error: 'unauthorized' }, 401) });
    try {
      await assert.rejects(
        () => real.run('hi', { model: 'sonar-reasoning-pro' }),
        // runWithRetry wraps the underlying error in a DispatcherError; the
        // rotate hint is appended to the wrapper's own message.
        (err) => /[Rr]otate at https:\/\/www\.perplexity\.ai/.test(String(err.message)),
      );
    } finally {
      restore();
    }
  });
});

test('perplexity: 429 retries and eventually succeeds', async () => {
  await withEnv({ PERPLEXITY_API_KEY: 'pplx-test' }, async () => {
    let calls = 0;
    const restore = fakeFetch({
      [URL]: () => {
        calls += 1;
        if (calls < 2) return okJson({ error: 'rate limit' }, 429);
        return okJson({ choices: [{ message: { content: 'retried ok' } }] });
      },
    });
    try {
      const text = await real.run('hi', { model: 'sonar-reasoning-pro' });
      assert.match(text, /retried ok/);
      assert.equal(calls, 2, 'should have retried once after the 429');
    } finally {
      restore();
    }
  });
});

test('perplexity: 500 retries up to attempts then throws', async () => {
  await withEnv({ PERPLEXITY_API_KEY: 'pplx-test' }, async () => {
    let calls = 0;
    const restore = fakeFetch({
      [URL]: () => {
        calls += 1;
        return okJson({ error: 'server' }, 500);
      },
    });
    try {
      await assert.rejects(
        () => real.run('hi', { model: 'sonar-reasoning-pro' }),
        (err) => /retries exhausted|DispatcherError/.test(err.message),
      );
      assert.ok(calls >= 2, 'should have retried at least once');
    } finally {
      restore();
    }
  });
});

test('perplexity: missing model argument throws', async () => {
  await withEnv({ PERPLEXITY_API_KEY: 'pplx-test' }, async () => {
    await assert.rejects(
      () => real.run('hi', {}),
      /ctx\.model is required/,
    );
  });
});

test('perplexity: empty content in response throws', async () => {
  await withEnv({ PERPLEXITY_API_KEY: 'pplx-test' }, async () => {
    const restore = fakeFetch({ [URL]: () => okJson({ choices: [{ message: { content: '   ' } }] }) });
    try {
      await assert.rejects(() => real.run('hi', { model: 'sonar-reasoning-pro' }), /empty content/);
    } finally {
      restore();
    }
  });
});

test('perplexity: deep-research model uses same endpoint', async () => {
  await withEnv({ PERPLEXITY_API_KEY: 'pplx-test' }, async () => {
    let captured;
    const restore = fakeFetch({
      [URL]: (init) => {
        captured = init;
        return okJson({ choices: [{ message: { content: 'research report' } }] });
      },
    });
    try {
      const text = await real.run('Research HTTP rate limiting 2025', {
        model: 'sonar-deep-research',
        requestId: 'req-dr',
      });
      assert.match(text, /research report/);
      const body = JSON.parse(captured.body);
      assert.equal(body.model, 'sonar-deep-research');
    } finally {
      restore();
    }
  });
});