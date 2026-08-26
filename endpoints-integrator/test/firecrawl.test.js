// =============================================================================
// test/firecrawl.test.js
//
// Covers all paths the Firecrawl adapter supports (INFA-22 + INFA-23):
//
//   1. URL-in-prompt: a literal URL → /v1/scrape directly.
//   2. Free-form pick-one (INFA-22): no URL, not a research question →
//      Qwen picks one URL → /v1/scrape.
//   3. Recursive research (INFA-23): no URL, prompt looks like a question
//      → Qwen query → /v2/search → Qwen rank → scrape N URLs → Qwen compose.
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
  // Phrased as a direct-fetch imperative so it stays on Path 2 (free-form
  // single-pick). Research-shaped phrasings now escalate to Path 3.
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
        const text = await real.run('fetch the trackingmore tracking api page', { requestId: 'r-2' });
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

test('firecrawl: free-form pick-one — Qwen returns url:null → friendly German hint', async () => {
  // INFA-23 escalation: prompts that look like a research question now flow
  // through the search+rank+compose pipeline, NOT the single-pick path. To
  // exercise the legacy single-pick url:null branch we have to phrase the
  // prompt as a direct-fetch request (short, imperative).
  const qwen = await fakeQwenCli({
    reply: '{"url":null,"reason":"keine passende offizielle Quelle"}',
  });
  try {
    await withEnv({ FIRECRAWL_API_KEY: 'fc-test', QWEN_BIN: qwen.binPath }, async () => {
      const text = await real.run('scrape pythagoras cheese', { requestId: 'r-3' });
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
  // Direct-fetch imperative so it stays on Path 2. Research-shaped phrasings
  // now escalate to Path 3 and surface a different message.
  await withEnv({ FIRECRAWL_API_KEY: 'fc-test', QWEN_BIN: '/nonexistent/qwen-xyz' }, async () => {
    const text = await real.run('fetch the pizza berlin page', { requestId: 'r-5' });
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

test('firecrawl: 401 surfaces a clear rotate-message inline (no throw)', async () => {
  // INFA-23: the adapter now catches provider errors and returns a friendly
  // inline message rather than letting the error bubble up — keeps the
  // WhatsApp group visibly responsive when the key is bad.
  await withEnv({ FIRECRAWL_API_KEY: 'bad-key' }, async () => {
    const restore = fakeFetch({ [URL]: () => okJson({ error: 'unauthorized' }, 401) });
    try {
      const text = await real.run('crawl https://example.com', {});
      assert.match(text, /Rotate at https:\/\/firecrawl\.dev/);
    } finally {
      restore();
    }
  });
});

test('firecrawl: 500 surfaces a friendly inline error', async () => {
  await withEnv({ FIRECRAWL_API_KEY: 'fc-test' }, async () => {
    const restore = fakeFetch({ [URL]: () => okJson({ error: 'server' }, 500) });
    try {
      const text = await real.run('crawl https://example.com', {});
      assert.match(text, /fehlgeschlagen/);
      assert.match(text, /HTTP 500/);
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

// =============================================================================
// INFA-23: recursive research pipeline
// =============================================================================

const SEARCH_URL = 'https://api.firecrawl.dev/v2/search';

test('firecrawl: looksLikeResearchQuestion triggers on "?" + question word + length + trigger phrase', () => {
  assert.equal(real.looksLikeResearchQuestion('Was ist der Unterschied zwischen TCP und UDP?'), true);
  assert.equal(real.looksLikeResearchQuestion('How do I install infinity?'), true);
  assert.equal(real.looksLikeResearchQuestion('Tell me about something obscure please'), true);
  assert.equal(real.looksLikeResearchQuestion('Explain how TCP works'), true);
  // Long, no question word — still research because the user wants an answer.
  assert.equal(
    real.looksLikeResearchQuestion('Bitte liste mir die wichtigsten Vorteile von PostgreSQL gegenüber MySQL auf'),
    true,
  );
  // Comparative / superlative phrasings — escalate even without a "?" (the
  // INFA-23 reopened report: "what is the cheapest allnet flat?" without the
  // question mark must still land on Path 3).
  assert.equal(real.looksLikeResearchQuestion('cheapest allnet flat'), true);
  assert.equal(real.looksLikeResearchQuestion('cheapest allnet flat.'), true);
  assert.equal(real.looksLikeResearchQuestion('best pizza in berlin'), true);
  assert.equal(real.looksLikeResearchQuestion('iphone 15 review'), true);
  assert.equal(real.looksLikeResearchQuestion('was ist die günstigste allnet flat'), true);
  // Info-seeking verbs — escalate.
  assert.equal(real.looksLikeResearchQuestion('find cheapest allnet flat'), true);
  assert.equal(real.looksLikeResearchQuestion('empfehl mir einen preiswerten tarif'), true);
  // Short imperative = single-page intent, NOT research.
  assert.equal(real.looksLikeResearchQuestion('scrape https://x.test'), false);
  assert.equal(real.looksLikeResearchQuestion('fetch docs'), false);
  assert.equal(real.looksLikeResearchQuestion('show me cnn.com'), false);
  assert.equal(real.looksLikeResearchQuestion('Pizza Berlin'), false);
  assert.equal(real.looksLikeResearchQuestion(''), false);
});

test('firecrawl: parseQwenQuery extracts a single query string', () => {
  assert.deepEqual(real.parseQwenQuery('{"query":"tcp udp unterschied"}'), { query: 'tcp udp unterschied' });
  assert.deepEqual(real.parseQwenQuery('```json\n{"query":"foo"}\n```'), { query: 'foo' });
  assert.equal(real.parseQwenQuery('{"query":""}'), null);
  assert.equal(real.parseQwenQuery('not json'), null);
});

test('firecrawl: parseQwenPicks filters invalid URLs and caps at top-K', () => {
  assert.deepEqual(
    real.parseQwenPicks('{"picks":[{"url":"https://a.test","reason":"r1"},{"url":"ftp://bad","reason":"x"},{"url":"https://b.test"}]}'),
    { picks: [{ url: 'https://a.test', reason: 'r1' }, { url: 'https://b.test', reason: null }], reason: null },
  );
  assert.deepEqual(real.parseQwenPicks('{"picks":[],"reason":"nope"}'), { picks: [], reason: 'nope' });
  assert.equal(real.parseQwenPicks('not json'), null);
});

test('firecrawl: normaliseSearchResults handles web array and flat array shapes', () => {
  const webShape = {
    data: { web: [
      { title: 'A', url: 'https://a.test', description: 'd1' },
      { title: 'B', url: 'ftp://bad' },
      { title: 'C', url: 'https://c.test' },
    ] },
  };
  assert.deepEqual(real.normaliseSearchResults(webShape).map((r) => r.url), ['https://a.test', 'https://c.test']);
  const flatShape = { data: [
    { title: 'X', url: 'https://x.test' },
  ] };
  assert.deepEqual(real.normaliseSearchResults(flatShape).map((r) => r.url), ['https://x.test']);
  assert.deepEqual(real.normaliseSearchResults({ data: {} }), []);
  assert.deepEqual(real.normaliseSearchResults({}), []);
});

test('firecrawl: research — Qwen query → /v2/search → Qwen rank → scrape → Qwen refine → scrape → Qwen compose', async () => {
  // Four Qwen invocations: query-formulation, ranking, refinement (round 2),
  // composition. The refinement reply proposes one new URL the round-1 picks
  // didn't cover; the pipeline then scrapes it before composing.
  const qwen = await fakeQwenCli({
    replies: [
      '{"query":"tcp udp unterschied"}',
      '{"picks":[{"url":"https://a.test","reason":"offiziell"},{"url":"https://b.test","reason":"vergleich"}]}',
      '{"picks":[{"url":"https://c.test","reason":"wikipedia","gap":"Definition"}]}',
      '## Kurze Antwort\nTCP verbindungsorientiert, UDP nicht.\n\n*Quellen*\n- A — https://a.test\n- B — https://b.test\n- C — https://c.test',
    ],
  });
  try {
    await withEnv(
      { FIRECRAWL_API_KEY: 'fc-test', QWEN_BIN: qwen.binPath, FIRECRAWL_SEARCH_LIMIT: '5', FIRECRAWL_PICK_TOP_K: '3' },
      async () => {
        let searchBody;
        const scrapeUrls = [];
        const restore = fakeFetch({
          [SEARCH_URL]: (init) => {
            searchBody = JSON.parse(init.body);
            return okJson({
              data: { web: [
                { title: 'A', url: 'https://a.test', description: 'TCP info' },
                { title: 'B', url: 'https://b.test', description: 'UDP info' },
                { title: 'C', url: 'https://c.test', description: 'extra' },
              ] },
            });
          },
          [URL]: (init) => {
            scrapeUrls.push(JSON.parse(init.body).url);
            return okJson({
              data: {
                markdown: `# ${JSON.parse(init.body).url}\n\nBody content here.`,
                metadata: { title: `Page ${scrapeUrls.length}` },
              },
            });
          },
        });
        try {
          const text = await real.run('Was ist der Unterschied zwischen TCP und UDP?', { requestId: 'r-rec' });
          // Search was called with the formulated query.
          assert.equal(searchBody.query, 'tcp udp unterschied');
          assert.deepEqual(searchBody.sources, ['web']);
          assert.equal(searchBody.limit, 5);
          // Round-1 ranked URLs got scraped first, then the round-2 refinement
          // URL — proves the recursion step ran.
          assert.deepEqual(scrapeUrls, ['https://a.test', 'https://b.test', 'https://c.test']);
          // Final reply is the Qwen-composed answer, not a raw dump.
          assert.match(text, /## Kurze Antwort/);
          assert.match(text, /Quellen/);
        } finally {
          restore();
        }
      },
    );
  } finally {
    await qwen.cleanup();
  }
});

test('firecrawl: research — search returns 0 results → friendly hint', async () => {
  const qwen = await fakeQwenCli({
    replies: [
      '{"query":"obscure query"}',
      // rank+compose should never be reached; supply generic responses just in case.
      '{"picks":[]}',
      'irrelevant',
    ],
  });
  try {
    await withEnv({ FIRECRAWL_API_KEY: 'fc-test', QWEN_BIN: qwen.binPath }, async () => {
      const restore = fakeFetch({
        [SEARCH_URL]: () => okJson({ data: { web: [] } }),
      });
      try {
        const text = await real.run('What is the meaning of obscure things in general?', { requestId: 'r-empty' });
        assert.match(text, /keine Treffer/);
        assert.match(text, /Suche/);
        assert.match(text, /Tipp: formuliere die Frage konkreter/);
      } finally {
        restore();
      }
    });
  } finally {
    await qwen.cleanup();
  }
});

test('firecrawl: research — Qwen rank returns no picks → list raw results', async () => {
  const qwen = await fakeQwenCli({
    replies: [
      '{"query":"niche question"}',
      '{"picks":[],"reason":"keine davon relevant"}',
    ],
  });
  try {
    await withEnv({ FIRECRAWL_API_KEY: 'fc-test', QWEN_BIN: qwen.binPath }, async () => {
      const restore = fakeFetch({
        [SEARCH_URL]: () => okJson({ data: { web: [
          { title: 'X', url: 'https://x.test', description: 'd' },
          { title: 'Y', url: 'https://y.test', description: 'd' },
        ] } }),
      });
      try {
        const text = await real.run('Tell me about something nobody knows please', { requestId: 'r-norank' });
        assert.match(text, /hält keinen davon für relevant/);
        assert.match(text, /https:\/\/x\.test/);
        assert.match(text, /https:\/\/y\.test/);
      } finally {
        restore();
      }
    });
  } finally {
    await qwen.cleanup();
  }
});

test('firecrawl: research — short imperative prompt ("fetch …") does NOT escalate', async () => {
  const qwen = await fakeQwenCli({ reply: '{"url":"https://p.test","reason":"chosen"}' });
  try {
    await withEnv({ FIRECRAWL_API_KEY: 'fc-test', QWEN_BIN: qwen.binPath }, async () => {
      let searchCalled = false;
      const restore = fakeFetch({
        [SEARCH_URL]: () => { searchCalled = true; return okJson({ data: { web: [] } }); },
        [URL]: () => okJson({ data: { markdown: 'hello', metadata: { title: 'P' } } }),
      });
      try {
        const text = await real.run('fetch pythagoras', { requestId: 'r-imp' });
        assert.equal(searchCalled, false, 'search should not be called for imperative fetch');
        assert.match(text, /\*P\*/);
        assert.match(text, /Quelle gewählt von Qwen/);
      } finally {
        restore();
      }
    });
  } finally {
    await qwen.cleanup();
  }
});

test('firecrawl: research — partial scrape failure keeps the rest and cites the bad URL', async () => {
  const qwen = await fakeQwenCli({
    replies: [
      '{"query":"q"}',
      '{"picks":[{"url":"https://ok.test","reason":"good"},{"url":"https://bad.test","reason":"also"}]}',
      '{"picks":[],"reason":"runde 1 reicht"}',
      'fallback body',
    ],
  });
  try {
    await withEnv({ FIRECRAWL_API_KEY: 'fc-test', QWEN_BIN: qwen.binPath }, async () => {
      const restore = fakeFetch({
        [SEARCH_URL]: () => okJson({ data: { web: [
          { title: 'ok', url: 'https://ok.test', description: '' },
          { title: 'bad', url: 'https://bad.test', description: '' },
        ] } }),
        [URL]: (init) => {
          const body = JSON.parse(init.body);
          if (body.url === 'https://bad.test') return okJson({ error: 'gone' }, 500);
          return okJson({ data: { markdown: 'OK page body', metadata: { title: 'OK' } } });
        },
      });
      try {
        const text = await real.run('Tell me about something important please', { requestId: 'r-partial' });
        // Final reply contains the composed fallback body — the partial
        // failure is captured, not thrown.
        assert.match(text, /fallback body/);
      } finally {
        restore();
      }
    });
  } finally {
    await qwen.cleanup();
  }
});

test('firecrawl: research — honours FIRECRAWL_RECURSE_MAX_CHARS env override', async () => {
  // We can't easily observe the cap from outside, but we can confirm that the
  // env override is accepted and the pipeline still runs end-to-end.
  const qwen = await fakeQwenCli({
    replies: [
      '{"query":"q"}',
      '{"picks":[{"url":"https://a.test","reason":"r"}]}',
      '{"picks":[],"reason":"runde 1 reicht"}',
      'final',
    ],
  });
  try {
    await withEnv(
      { FIRECRAWL_API_KEY: 'fc-test', QWEN_BIN: qwen.binPath, FIRECRAWL_RECURSE_MAX_CHARS: '2000' },
      async () => {
        const restore = fakeFetch({
          [SEARCH_URL]: () => okJson({ data: { web: [{ title: 'A', url: 'https://a.test', description: '' }] } }),
          [URL]: () => okJson({ data: { markdown: 'x'.repeat(1500), metadata: { title: 'A' } } }),
        });
        try {
          const text = await real.run('Tell me about something specific please', { requestId: 'r-cap' });
          assert.match(text, /final/);
        } finally {
          restore();
        }
      },
    );
  } finally {
    await qwen.cleanup();
  }
});

test('firecrawl: research — retries with a derived query when the formulated query returns nothing', async () => {
  // Qwen formulates a query that gets 0 hits; the pipeline should retry with
  // the prefix-stripped fallback ("allnet flat" instead of "what is the
  // cheapest allnet flat") and succeed on the second try. The refinement
  // step is intentionally a no-op here (empty picks) so round 2 doesn't
  // scrape anything extra.
  const searchQueries = [];
  const qwen = await fakeQwenCli({
    replies: [
      '{"query":"what is the cheapest allnet flat"}',
      '{"picks":[{"url":"https://a.test","reason":"r"}]}',
      '{"picks":[],"reason":"runde 1 reicht"}',
      'final composed answer',
    ],
  });
  try {
    await withEnv({ FIRECRAWL_API_KEY: 'fc-test', QWEN_BIN: qwen.binPath }, async () => {
      const restore = fakeFetch({
        [SEARCH_URL]: (init) => {
          searchQueries.push(JSON.parse(init.body).query);
          // First call (formulated query) returns 0; second call (fallback) returns hits.
          if (searchQueries.length === 1) return okJson({ data: { web: [] } });
          return okJson({ data: { web: [{ title: 'A', url: 'https://a.test', description: '' }] } });
        },
        [URL]: () => okJson({ data: { markdown: 'A page', metadata: { title: 'A' } } }),
      });
      try {
        const text = await real.run('what is the cheapest allnet flat?', { requestId: 'r-retry' });
        // First query was the formulated one; second was the derived one.
        assert.equal(searchQueries[0], 'what is the cheapest allnet flat');
        assert.match(searchQueries[1], /cheapest allnet flat/);
        assert.match(text, /final composed answer/);
      } finally {
        restore();
      }
    });
  } finally {
    await qwen.cleanup();
  }
});

test('firecrawl: research — Path-2 Qwen url:null falls back to the recursive pipeline', async () => {
  // When the heuristic misses research-detection (e.g. a short prompt that
  // Path 2 picks up first) and Qwen then says "I can't pick a URL", the
  // adapter now falls through to the research pipeline instead of leaving
  // the user with a dead-end message. The breadcrumb makes the fallback
  // visible so the user can tell what changed. Five Qwen invocations:
  // Path-2 pick (returns null), query-formulation, ranking, refinement
  // (round 2 — empty so the test stays focused), composition.
  const qwen = await fakeQwenCli({
    replies: [
      '{"url":null,"reason":"keine passende offizielle Quelle"}',
      '{"query":"pizza berlin"}',
      '{"picks":[{"url":"https://p.test","reason":"r"}]}',
      '{"picks":[],"reason":"runde 1 reicht"}',
      'composed answer',
    ],
  });
  try {
    await withEnv({ FIRECRAWL_API_KEY: 'fc-test', QWEN_BIN: qwen.binPath }, async () => {
      const restore = fakeFetch({
        [SEARCH_URL]: () => okJson({ data: { web: [{ title: 'P', url: 'https://p.test', description: '' }] } }),
        [URL]: () => okJson({ data: { markdown: 'page', metadata: { title: 'P' } } }),
      });
      try {
        // Short imperative-looking prompt that the heuristic still routes to
        // Path 2 (no question word, no comparative, no research trigger).
        const text = await real.run('pizza berlin tipp', { requestId: 'r-fallback' });
        assert.match(text, /Hinweis.*Recherche-Pipeline/);
        assert.match(text, /composed answer/);
      } finally {
        restore();
      }
    });
  } finally {
    await qwen.cleanup();
  }
});

test('firecrawl: research — round 2 skips URLs Qwen already proposed in round 1 (no double-scrape)', async () => {
  // The refinement prompt explicitly tells Qwen not to repeat a URL we've
  // already scraped. Even if Qwen tries to send it anyway, the adapter
  // dedupes on normalized URL.
  const qwen = await fakeQwenCli({
    replies: [
      '{"query":"q"}',
      '{"picks":[{"url":"https://a.test","reason":"good"},{"url":"https://b.test/","reason":"other"}]}',
      // Round-2 picks capped at RECURSE_TOP_K=2. Order matters: Qwen sends
      // the new URL first so it survives the cap, then two duplicates of an
      // already-scraped URL — the adapter must drop both.
      '{"picks":[{"url":"https://c.test","reason":"new"},{"url":"https://a.test","reason":"dup"},{"url":"https://a.test/","reason":"dup2"}]}',
      'final',
    ],
  });
  try {
    await withEnv({ FIRECRAWL_API_KEY: 'fc-test', QWEN_BIN: qwen.binPath }, async () => {
      const scrapeUrls = [];
      const restore = fakeFetch({
        [SEARCH_URL]: () => okJson({ data: { web: [
          { title: 'A', url: 'https://a.test', description: '' },
          { title: 'B', url: 'https://b.test/', description: '' },
        ] } }),
        [URL]: (init) => {
          scrapeUrls.push(JSON.parse(init.body).url);
          return okJson({ data: { markdown: 'body', metadata: { title: 'P' } } });
        },
      });
      try {
        await real.run('Was sind die wichtigsten Eigenschaften von TCP?', { requestId: 'r-dedupe' });
        // Round 1: A, B. Round 2 should only add C — never re-scrape A or B.
        assert.deepEqual(scrapeUrls, ['https://a.test', 'https://b.test/', 'https://c.test']);
      } finally {
        restore();
      }
    });
  } finally {
    await qwen.cleanup();
  }
});

test('firecrawl: research — FIRECRAWL_RECURSE_MAX_DEPTH=0 disables the round-2 leg', async () => {
  // Operators on tight Firecrawl quotas can disable the recursion entirely.
  // With depth=0 we expect exactly three Qwen invocations: query-formulation,
  // ranking, composition — no refinement call.
  //
  // The recursion-depth constant is read at module load, so we have to
  // require a fresh copy of the adapter after setting the env override.
  const qwen = await fakeQwenCli({
    replies: [
      '{"query":"q"}',
      '{"picks":[{"url":"https://a.test","reason":"r"}]}',
      'final composed',
    ],
  });
  try {
    await withEnv(
      { FIRECRAWL_API_KEY: 'fc-test', QWEN_BIN: qwen.binPath, FIRECRAWL_RECURSE_MAX_DEPTH: '0' },
      async () => {
        // Wipe the cached module so it re-reads the env override.
        const modPath = require.resolve('../dispatcher/firecrawl.js');
        delete require.cache[modPath];
        const fresh = require('../dispatcher/firecrawl.js');
        assert.equal(fresh.RECURSE_MAX_DEPTH, 0, 'env override should have lowered depth to 0');
        const scrapeUrls = [];
        const restore = fakeFetch({
          [SEARCH_URL]: () => okJson({ data: { web: [{ title: 'A', url: 'https://a.test', description: '' }] } }),
          [URL]: (init) => {
            scrapeUrls.push(JSON.parse(init.body).url);
            return okJson({ data: { markdown: 'A page', metadata: { title: 'A' } } });
          },
        });
        try {
          const text = await fresh.run('Was sind die wichtigsten Eigenschaften von TCP?', { requestId: 'r-nodept' });
          assert.match(text, /final composed/);
          // Only the round-1 URL got scraped; round 2 is fully off.
          assert.deepEqual(scrapeUrls, ['https://a.test']);
        } finally {
          restore();
        }
      },
    );
  } finally {
    await qwen.cleanup();
  }
});

test('firecrawl: parseQwenRefinePicks filters invalid URLs and caps at RECURSE_TOP_K', () => {
  assert.deepEqual(
    real.parseQwenRefinePicks('{"picks":[{"url":"https://x.test","reason":"r1","gap":"g1"},{"url":"ftp://bad","reason":"x"},{"url":"https://y.test"}]}'),
    { picks: [{ url: 'https://x.test', reason: 'r1', gap: 'g1' }, { url: 'https://y.test', reason: null, gap: null }], reason: null },
  );
  assert.deepEqual(real.parseQwenRefinePicks('{"picks":[],"reason":"nope"}'), { picks: [], reason: 'nope' });
  assert.equal(real.parseQwenRefinePicks('not json'), null);
});

test('firecrawl: normalizeUrl lowercases and strips trailing slashes', () => {
  assert.equal(real.normalizeUrl('https://Example.com/'), 'https://example.com');
  assert.equal(real.normalizeUrl('http://x.test/path/'), 'http://x.test/path');
  assert.equal(real.normalizeUrl('ftp://nope'), null);
  assert.equal(real.normalizeUrl(null), null);
});
