// =============================================================================
// test/firecrawl.test.js
//
// Covers both paths the INFA-22 Firecrawl adapter supports:
//
//   1. URL-in-prompt: a literal URL → /v1/scrape directly.
//   2. Free-form: no URL → Qwen picks one → /v1/scrape.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const real = require('../dispatcher/firecrawl.js');
const { fakeFetch, okJson, fakeQwenCli, withEnv } = require('./helpers.js');

const URL = 'https://api.firecrawl.dev/v1/scrape';

test('firecrawl: extracts URL from prompt and returns title + markdown', async () => {
  await withEnv({ FIRECRAWL_API_KEY: 'fc-test' }, async () => {
    let captured;
    const restore = fakeFetch({
      [URL]: (init) => {
        captured = init;
        return okJson({
          data: {
            markdown: '# Example Domain\n\nThis domain is for use in illustrative examples.',
            metadata: { title: 'Example Domain', description: 'Example' },
          },
        });
      },
    });
    try {
      const text = await real.run('Crawl https://example.com and return the title', { requestId: 'r-1' });
      assert.match(text, /\*Example Domain\*/);
      assert.match(text, /illustrative examples/);
      const body = JSON.parse(captured.body);
      assert.equal(body.url, 'https://example.com');
      assert.deepEqual(body.formats, ['markdown']);
      assert.equal(body.onlyMainContent, true);
      assert.equal(captured.headers.Authorization, 'Bearer fc-test');
    } finally {
      restore();
    }
  });
});

test('firecrawl: free-form prompt — Qwen picks URL, then /v1/scrape is called with it', async () => {
  const qwen = await fakeQwenCli({
    reply: '```json\n{"url":"https://www.trackingmore.com/en/tracking-api.html","reason":"good tracking API"}\n```',
  });
  try {
    await withEnv({ FIRECRAWL_API_KEY: 'fc-test', QWEN_BIN: qwen.binPath }, async () => {
      let captured;
      const restore = fakeFetch({
        [URL]: (init) => {
          captured = init;
          return okJson({
            data: {
              markdown: 'Best tracking API overview',
              metadata: { title: 'TrackingMore API' },
            },
          });
        },
      });
      try {
        const text = await real.run('Look up the best API for package tracking.', { requestId: 'r-2' });
        assert.match(text, /\*TrackingMore API\*/);
        assert.match(text, /Best tracking API overview/);
        assert.match(text, /Quelle gewählt von Qwen/);
        const body = JSON.parse(captured.body);
        assert.equal(body.url, 'https://www.trackingmore.com/en/tracking-api.html');
      } finally {
        restore();
      }
    });
  } finally {
    await qwen.cleanup();
  }
});

test('firecrawl: free-form prompt — Qwen returns url:null → friendly German hint', async () => {
  const qwen = await fakeQwenCli({
    reply: '{"url":null,"reason":"keine passende offizielle Quelle"}',
  });
  try {
    await withEnv({ FIRECRAWL_API_KEY: 'fc-test', QWEN_BIN: qwen.binPath }, async () => {
      const text = await real.run('Was hat Pythagoras mit Käse zu tun?', { requestId: 'r-3' });
      assert.match(text, /keine passende URL/);
      assert.match(text, /keine passende offizielle Quelle/);
      assert.match(text, /Tipp: schick eine konkrete URL/);
    });
  } finally {
    await qwen.cleanup();
  }
});

test('firecrawl: free-form prompt — Qwen reply not parseable JSON → clear error', async () => {
  const qwen = await fakeQwenCli({ reply: 'I have no idea what to say' });
  try {
    await withEnv({ FIRECRAWL_API_KEY: 'fc-test', QWEN_BIN: qwen.binPath }, async () => {
      const text = await real.run('something obscure', { requestId: 'r-4' });
      assert.match(text, /Fehler bei der Qwen-Planung/);
      assert.match(text, /unparseable planning reply/i);
    });
  } finally {
    await qwen.cleanup();
  }
});

test('firecrawl: free-form prompt — Qwen CLI missing → operator-friendly hint (no throw)', async () => {
  await withEnv({ FIRECRAWL_API_KEY: 'fc-test', QWEN_BIN: '/nonexistent/qwen-xyz' }, async () => {
    const text = await real.run('Look up the best pizza in Berlin', { requestId: 'r-5' });
    assert.match(text, /Fehler bei der Qwen-Planung/);
    assert.match(text, /qwen CLI not found/);
  });
});

test('firecrawl: parseQwenPick handles plain JSON and ```json fences', () => {
  assert.deepEqual(
    real.parseQwenPick('{"url":"https://x.test","reason":"r"}'),
    { url: 'https://x.test', reason: 'r' },
  );
  assert.deepEqual(
    real.parseQwenPick('```json\n{"url":"https://x.test"}\n```'),
    { url: 'https://x.test', reason: null },
  );
  assert.deepEqual(
    real.parseQwenPick('Sicher: {"url":null,"reason":"x"}!'),
    { url: null, reason: 'x' },
  );
  assert.equal(real.parseQwenPick('not json at all'), null);
  assert.equal(real.parseQwenPick('{"url":"ftp://x.test"}'), null);
  assert.equal(real.parseQwenPick(''), null);
});

test('firecrawl: missing api key → INFA-20 friendly stub (no AuthError throw)', async () => {
  await withEnv({ FIRECRAWL_API_KEY: '' }, async () => {
    const text = await real.run('crawl https://example.com', {});
    assert.match(text, /\*Firecrawl\* \(Stub\)/);
    assert.match(text, /Erkannte URL: https:\/\/example\.com/);
  });
});

test('firecrawl: 401 surfaces a clear rotate-message', async () => {
  await withEnv({ FIRECRAWL_API_KEY: 'bad-key' }, async () => {
    const restore = fakeFetch({ [URL]: () => okJson({ error: 'unauthorized' }, 401) });
    try {
      await assert.rejects(
        () => real.run('crawl https://example.com', {}),
        (err) => /[Rr]otate at https:\/\/firecrawl\.dev/.test(String(err.message)),
      );
    } finally {
      restore();
    }
  });
});

test('firecrawl: 500 retries then fails', async () => {
  await withEnv({ FIRECRAWL_API_KEY: 'fc-test' }, async () => {
    let calls = 0;
    const restore = fakeFetch({
      [URL]: () => {
        calls += 1;
        return okJson({ error: 'server' }, 500);
      },
    });
    try {
      await assert.rejects(
        () => real.run('crawl https://example.com', {}),
        /retries exhausted|DispatcherError/,
      );
      assert.ok(calls >= 2, 'should have retried at least once');
    } finally {
      restore();
    }
  });
});

test('firecrawl: strips trailing punctuation from URLs', () => {
  assert.equal(real.extractUrl('scrape https://example.com.'), 'https://example.com');
  assert.equal(real.extractUrl('scrape https://example.com!'), 'https://example.com');
  assert.equal(real.extractUrl('https://example.com/foo)'), 'https://example.com/foo');
});

test('firecrawl: respects FIRECRAWL_BASE_URL env override', async () => {
  await withEnv({ FIRECRAWL_API_KEY: 'fc-test', FIRECRAWL_BASE_URL: 'https://firecrawl.self.hosted' }, async () => {
    let captured;
    const restore = fakeFetch({
      'https://firecrawl.self.hosted/v1/scrape': (init) => {
        captured = init;
        return okJson({ data: { markdown: 'hello', metadata: { title: 'T' } } });
      },
    });
    try {
      const text = await real.run('crawl https://example.com', {});
      assert.match(text, /\*T\*/);
      assert.equal(captured.headers.Authorization, 'Bearer fc-test');
    } finally {
      restore();
    }
  });
});
