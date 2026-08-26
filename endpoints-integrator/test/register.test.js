// =============================================================================
// test/register.test.js
//
// Verifies that `register.js` exposes the AdapterFactory shape the WhatsApp
// client expects: globalThis.INFINITY_INTEGRATOR_ADAPTERS(name) returns
// { name, run(prompt, ctx) -> Promise<{ text, mediaRefs, usage? }> }.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  adapterFactory,
  NAME_TO_DISPATCH_KEY,
  SUPPORTED_NAMES,
  InvalidEndpointError,
} = require('../register.js');
const { fakeFetch, okJson, fakeQwenCli, withEnv } = require('./helpers.js');

test('register: lists the four supported adapter names', () => {
  assert.deepEqual([...SUPPORTED_NAMES].sort(), [
    'firecrawl',
    'perplexityDeepResearch',
    'perplexityReasoning',
    'qwenCode',
  ]);
});

test('register: maps WhatsApp names to dispatcher keys', () => {
  assert.equal(NAME_TO_DISPATCH_KEY.qwenCode, 'qwen');
  assert.equal(NAME_TO_DISPATCH_KEY.perplexityReasoning, 'perplexity-reasoning-pro');
  assert.equal(NAME_TO_DISPATCH_KEY.perplexityDeepResearch, 'perplexity-deep-research');
  assert.equal(NAME_TO_DISPATCH_KEY.firecrawl, 'firecrawl');
});

test('register: factory throws InvalidEndpointError on unknown name', () => {
  assert.throws(() => adapterFactory('not-real'), InvalidEndpointError);
});

test('register: factory returns IntegratorAdapter shape for each endpoint', () => {
  for (const name of SUPPORTED_NAMES) {
    const a = adapterFactory(name);
    assert.equal(a.name, name);
    assert.equal(typeof a.run, 'function');
  }
});

test('register: side-effect installs globalThis.INFINITY_INTEGRATOR_ADAPTERS', () => {
  assert.equal(typeof globalThis.INFINITY_INTEGRATOR_ADAPTERS, 'function');
  const a = globalThis.INFINITY_INTEGRATOR_ADAPTERS('qwenCode');
  assert.equal(a.name, 'qwenCode');
});

test('register: qwenCode.run forwards to qwen CLI via dispatch', async () => {
  const fake = await fakeQwenCli({ reply: 'register qwen ok' });
  try {
    await withEnv({ QWEN_BIN: fake.binPath }, async () => {
      const a = adapterFactory('qwenCode');
      const reply = await a.run('hello', { requestId: 'r-1', group: 'Qwen', mediaPaths: [] });
      assert.match(reply.text, /register qwen ok/);
      assert.deepEqual(reply.mediaRefs, []);
      assert.equal(typeof reply.usage?.latencyMs, 'number');
    });
  } finally {
    await fake.cleanup();
  }
});

test('register: perplexityReasoning.run hits sonar-reasoning-pro', async () => {
  await withEnv({ PERPLEXITY_API_KEY: 'pplx-test' }, async () => {
    let captured;
    const restore = fakeFetch({
      'https://api.perplexity.ai/chat/completions': (init) => {
        captured = init;
        return okJson({ choices: [{ message: { content: 'rp via register' } }] });
      },
    });
    try {
      const a = adapterFactory('perplexityReasoning');
      const reply = await a.run('hi', { requestId: 'r-2', group: 'Perp. RP' });
      assert.match(reply.text, /rp via register/);
      assert.equal(JSON.parse(captured.body).model, 'sonar-reasoning-pro');
    } finally {
      restore();
    }
  });
});

test('register: perplexityDeepResearch.run hits sonar-deep-research', async () => {
  await withEnv({ PERPLEXITY_API_KEY: 'pplx-test' }, async () => {
    let captured;
    const restore = fakeFetch({
      'https://api.perplexity.ai/chat/completions': (init) => {
        captured = init;
        return okJson({ choices: [{ message: { content: 'dr via register' } }] });
      },
    });
    try {
      const a = adapterFactory('perplexityDeepResearch');
      const reply = await a.run('Research X', { requestId: 'r-3', group: 'Perp. DR' });
      assert.match(reply.text, /dr via register/);
      assert.equal(JSON.parse(captured.body).model, 'sonar-deep-research');
    } finally {
      restore();
    }
  });
});

test('register: firecrawl.run extracts URL and posts to /v1/scrape', async () => {
  await withEnv({ FIRECRAWL_API_KEY: 'fc-test' }, async () => {
    const restore = fakeFetch({
      'https://api.firecrawl.dev/v1/scrape': () =>
        okJson({
          data: { markdown: 'm body', metadata: { title: 'T' } },
        }),
    });
    try {
      const a = adapterFactory('firecrawl');
      const reply = await a.run('summarize https://example.com', {
        requestId: 'r-4',
        group: 'Firecrawl',
      });
      assert.match(reply.text, /\*T\*/);
      assert.match(reply.text, /m body/);
    } finally {
      restore();
    }
  });
});

test('register: returns a friendly stub when the API key is missing (INFA-20)', async () => {
  await withEnv({ PERPLEXITY_API_KEY: '' }, async () => {
    const a = adapterFactory('perplexityReasoning');
    const reply = await a.run('hi', { requestId: 'r-x', group: 'Perp. RP' });
    // INFA-20 contract: never leave a configured group silent. When
    // PERPLEXITY_API_KEY is unset the adapter returns a localized stub
    // telling the operator how to fix the credential gap, instead of
    // bubbling an AuthError into the dispatcher (which would otherwise
    // surface as an opaque "Fehler bei …" reply in WhatsApp).
    assert.match(reply.text, /Perplexity/i);
    assert.match(reply.text, /PERPLEXITY_API_KEY/);
    assert.match(reply.text, /Stub/i);
  });
});

test('register: returns a friendly stub for firecrawl when FIRECRAWL_API_KEY is missing (INFA-20)', async () => {
  await withEnv({ FIRECRAWL_API_KEY: '' }, async () => {
    const a = adapterFactory('firecrawl');
    const reply = await a.run('summarize https://example.com', {
      requestId: 'r-y',
      group: 'Firecrawl',
    });
    assert.match(reply.text, /Firecrawl/i);
    assert.match(reply.text, /FIRECRAWL_API_KEY/);
    assert.match(reply.text, /Stub/i);
    // URL is echoed back so the operator can confirm routing works.
    assert.match(reply.text, /example\.com/);
  });
});
