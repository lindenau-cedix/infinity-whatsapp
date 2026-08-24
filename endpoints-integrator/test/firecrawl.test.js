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

test('firecrawl: missing api key throws AuthError', async () => {
  await withEnv({ FIRECRAWL_API_KEY: '' }, async () => {
    await assert.rejects(
      () => real.run('crawl https://example.com', {}),
      (err) => err.name === 'AuthError' && err.key === 'FIRECRAWL_API_KEY',
    );
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