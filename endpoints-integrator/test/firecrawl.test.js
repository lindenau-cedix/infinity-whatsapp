// =============================================================================
// test/firecrawl.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const real = require('../dispatcher/firecrawl.js');
const { fakeFetch, okJson, withEnv } = require('./helpers.js');

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

test('firecrawl: returns a friendly hint when no URL is present', async () => {
  await withEnv({ FIRECRAWL_API_KEY: 'fc-test' }, async () => {
    const text = await real.run('Tell me about Kubernetes probes', {});
    assert.match(text, /needs a URL/);
  });
});

test('firecrawl: missing api key returns a friendly stub (INFA-20)', async () => {
  await withEnv({ FIRECRAWL_API_KEY: '' }, async () => {
    // INFA-20 contract change: instead of bubbling an AuthError that the
    // dispatcher turns into an opaque "Fehler bei …" reply, the adapter
    // returns a localized stub so the operator sees something useful
    // immediately and knows exactly which key to set.
    const text = await real.run('crawl https://example.com', {});
    assert.match(text, /Firecrawl/i);
    assert.match(text, /FIRECRAWL_API_KEY/);
    assert.match(text, /Stub/i);
    // The detected URL is echoed back so routing is observable.
    assert.match(text, /example\.com/);
  });
});

test('firecrawl: ctx.apiKey is honored even when env key is missing', async () => {
  await withEnv({ FIRECRAWL_API_KEY: '' }, async () => {
    const restore = fakeFetch({
      [URL]: () => okJson({ data: { markdown: 'm body', metadata: { title: 'T' } } }),
    });
    try {
      const text = await real.run('crawl https://example.com', { apiKey: 'ctx-supplied-key' });
      assert.match(text, /\*T\*/);
      assert.match(text, /m body/);
    } finally {
      restore();
    }
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