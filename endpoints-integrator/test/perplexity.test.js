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

test('perplexity: undici "fetch failed" with ECONNRESET cause is retried and surfaces the real code (INFA-24)', async () => {
  await withEnv({ PERPLEXITY_API_KEY: 'pplx-test' }, async () => {
    let calls = 0;
    const original = global.fetch;
    global.fetch = async () => {
      calls += 1;
      if (calls < 2) {
        // Mirror Node 18+ undici: TypeError("fetch failed") wrapping a
        // ECONNRESET cause. Before INFA-24 the retry classifier ignored
        // this and threw "all retries exhausted: fetch failed" with no
        // signal what actually went wrong.
        const cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        throw Object.assign(new TypeError('fetch failed'), { cause });
      }
      return okJson({ choices: [{ message: { content: 'recovered' } }] });
    };
    const restore = () => { global.fetch = original; };
    try {
      const text = await real.run('hi', { model: 'sonar-reasoning-pro' });
      assert.match(text, /recovered/);
      assert.equal(calls, 2, 'should have retried once after ECONNRESET');
    } finally {
      restore();
    }
  });
});

test('perplexity: persistent ECONNRESET surfaces the underlying code in the error (INFA-24)', async () => {
  await withEnv({ PERPLEXITY_API_KEY: 'pplx-test' }, async () => {
    const original = global.fetch;
    global.fetch = async () => {
      const cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      throw Object.assign(new TypeError('fetch failed'), { cause });
    };
    const restore = () => { global.fetch = original; };
    try {
      await assert.rejects(
        () => real.run('hi', { model: 'sonar-reasoning-pro' }),
        (err) => /ECONNRESET/.test(String(err.message)) && /all retries exhausted/.test(String(err.message)),
      );
    } finally {
      restore();
    }
  });
});

// INFA-24 follow-up: the original fix retried only when .cause had a known
// .code. undici 22+ and several TLS/proxy races surface fetch-time failures
// as `TypeError('fetch failed')` or even `Error('fetch failed')` with a
// null or code-less .cause. The retry classifier now treats the wrapper
// itself as retriable, so a single transient blip no longer kills the call.

test('perplexity: "fetch failed" with no .cause at all is retried and recovers (INFA-24 follow-up)', async () => {
  await withEnv({ PERPLEXITY_API_KEY: 'pplx-test' }, async () => {
    let calls = 0;
    const original = global.fetch;
    global.fetch = async () => {
      calls += 1;
      if (calls < 2) {
        // TLS race / proxy drop: undici throws TypeError("fetch failed")
        // with .cause === undefined. Before the fix this aborted the call
        // and surfaced "all retries exhausted: fetch failed".
        throw new TypeError('fetch failed');
      }
      return okJson({ choices: [{ message: { content: 'recovered-no-cause' } }] });
    };
    const restore = () => { global.fetch = original; };
    try {
      const text = await real.run('hi', { model: 'sonar-deep-research' });
      assert.match(text, /recovered-no-cause/);
      assert.equal(calls, 2, 'should have retried once after opaque fetch failed');
    } finally {
      restore();
    }
  });
});

test('perplexity: "fetch failed" with cause carrying only .name is retried (INFA-24 follow-up)', async () => {
  await withEnv({ PERPLEXITY_API_KEY: 'pplx-test' }, async () => {
    let calls = 0;
    const original = global.fetch;
    global.fetch = async () => {
      calls += 1;
      if (calls < 2) {
        // undici socket-shape: cause has .name but no .code. The previous
        // classifier skipped past it (no .code), giving up on a retriable
        // socket blip.
        const cause = Object.assign(new Error('socket hang up'), { name: 'SocketError' });
        throw Object.assign(new TypeError('fetch failed'), { cause });
      }
      return okJson({ choices: [{ message: { content: 'recovered-name-only' } }] });
    };
    const restore = () => { global.fetch = original; };
    try {
      const text = await real.run('hi', { model: 'sonar-deep-research' });
      assert.match(text, /recovered-name-only/);
      assert.equal(calls, 2, 'should have retried once after name-only cause');
    } finally {
      restore();
    }
  });
});

test('perplexity: persistent opaque "fetch failed" surfaces cause message in the error (INFA-24 follow-up)', async () => {
  await withEnv({ PERPLEXITY_API_KEY: 'pplx-test' }, async () => {
    const original = global.fetch;
    global.fetch = async () => {
      // undici-22+ plain-Error wrapper, no .code anywhere. We still want
      // the operator to see *something* more informative than a bare
      // "fetch failed" — surface the cause's message if available.
      const cause = new Error('TLS handshake timeout after 30s');
      throw Object.assign(new Error('fetch failed'), { cause });
    };
    const restore = () => { global.fetch = original; };
    try {
      await assert.rejects(
        () => real.run('hi', { model: 'sonar-deep-research' }),
        (err) => /TLS handshake timeout/.test(String(err.message)) && /all retries exhausted/.test(String(err.message)),
      );
    } finally {
      restore();
    }
  });
});

test('perplexity: persistent bare "fetch failed" with no cause still surfaces retriable status (INFA-24 follow-up)', async () => {
  await withEnv({ PERPLEXITY_API_KEY: 'pplx-test' }, async () => {
    const original = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      // Worst case: wrapper only, no cause, no code, no name. The wrapper
      // ITSELF is the diagnostic. We retry per the new classifier and on
      // exhaustion surface the wrapper message verbatim (the operator
      // should know undici said "fetch failed").
      throw new TypeError('fetch failed');
    };
    const restore = () => { global.fetch = original; };
    try {
      await assert.rejects(
        () => real.run('hi', { model: 'sonar-deep-research' }),
        (err) => /fetch failed/.test(String(err.message)) && /all retries exhausted/.test(String(err.message)),
      );
      // 4 attempts for deep-research (attempts=4) — confirms we DID retry
      // instead of giving up after the first opaque failure.
      assert.equal(calls, 4, 'opaque fetch failed should still be retried 3 times');
    } finally {
      restore();
    }
  });
});