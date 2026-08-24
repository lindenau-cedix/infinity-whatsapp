// Integration smoke for the WA -> Integrator seam.
// Runs against the compiled dist/ — no live WhatsApp or HTTP.

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Dispatcher } = require('../dist/dispatcher.js');
const { Logger } = require('../dist/logger.js');

function makeGroup(endpoint, jid) {
  return { jid, label: endpoint, endpoint };
}

class FakeAdapter {
  constructor(groups) {
    this.status = { state: 'ready' };
    this.groups = groups;
    this.sent = [];
    this.handlers = [];
  }
  start() { return Promise.resolve(); }
  stop() { return Promise.resolve(); }
  onMessage(h) { this.handlers.push(h); }
  onEvent() {}
  getStatus() { return { ...this.status }; }
  sendReply(jid, reply) {
    this.sent.push({ jid, reply });
    return Promise.resolve();
  }
  /** Test helper: fire a synthetic inbound message. */
  emit(msg) {
    for (const h of this.handlers) h(msg);
  }
}

function makeFactory() {
  const calls = [];
  return {
    calls,
    factory(name) {
      return {
        name,
        async run(prompt, ctx) {
          calls.push({ name, prompt, ctx });
          return {
            text: `echo[${name}]: ${prompt}`,
            mediaRefs: [],
            usage: { latencyMs: 1 },
          };
        },
      };
    },
  };
}

test('routes by endpoint and echoes text reply to the group JID', async () => {
  const groups = {
    qwenCode: makeGroup('qwenCode', 'g-qwen@g.us'),
    perplexityReasoning: makeGroup('perplexityReasoning', 'g-rp@g.us'),
    perplexityDeepResearch: makeGroup('perplexityDeepResearch', 'g-dr@g.us'),
    firecrawl: makeGroup('firecrawl', 'g-fc@g.us'),
  };
  const adapter = new FakeAdapter(groups);
  const { factory, calls } = makeFactory();
  const dispatcher = new Dispatcher(adapter, factory, new Logger('smoke', 'silent'));
  dispatcher.bind();

  adapter.emit({
    transportId: 't1',
    group: groups.qwenCode,
    authorId: 'user@x',
    text: 'hello qwen',
    media: [],
    voiceReply: false,
    grillMe: false,
    receivedAt: Date.now(),
  });

  // Wait for the async handler chain.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'qwenCode');
  assert.equal(calls[0].prompt, 'hello qwen');
  assert.equal(adapter.sent.length, 1);
  assert.equal(adapter.sent[0].jid, 'g-qwen@g.us');
  assert.equal(adapter.sent[0].reply.text, 'echo[qwenCode]: hello qwen');
  assert.equal(adapter.sent[0].reply.asVoice, false);
});

test('forwards voiceReply flag through to EgressReply.asVoice', async () => {
  const groups = {
    qwenCode: makeGroup('qwenCode', 'g-qwen@g.us'),
    perplexityReasoning: makeGroup('perplexityReasoning', 'g-rp@g.us'),
    perplexityDeepResearch: makeGroup('perplexityDeepResearch', 'g-dr@g.us'),
    firecrawl: makeGroup('firecrawl', 'g-fc@g.us'),
  };
  const adapter = new FakeAdapter(groups);
  const { factory } = makeFactory();
  const dispatcher = new Dispatcher(adapter, factory, new Logger('smoke', 'silent'));
  dispatcher.bind();

  adapter.emit({
    transportId: 't2',
    group: groups.perplexityReasoning,
    authorId: 'user@x',
    text: 'Antworte sprachlich: erkläre TCP',
    media: [],
    voiceReply: true,
    grillMe: false,
    receivedAt: Date.now(),
  });

  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(adapter.sent.length, 1);
  assert.equal(adapter.sent[0].reply.asVoice, true);
  assert.match(adapter.sent[0].reply.text, /echo\[perplexityReasoning\]:/);
});

test('surfaces endpoint failures as a localized error message', async () => {
  const groups = {
    qwenCode: makeGroup('qwenCode', 'g-qwen@g.us'),
    perplexityReasoning: makeGroup('perplexityReasoning', 'g-rp@g.us'),
    perplexityDeepResearch: makeGroup('perplexityDeepResearch', 'g-dr@g.us'),
    firecrawl: makeGroup('firecrawl', 'g-fc@g.us'),
  };
  const adapter = new FakeAdapter(groups);
  const dispatcher = new Dispatcher(
    adapter,
    (name) => ({
      name,
      async run() { throw new Error('boom'); },
    }),
    new Logger('smoke', 'silent'),
  );
  dispatcher.bind();

  adapter.emit({
    transportId: 't3',
    group: groups.firecrawl,
    authorId: 'user@x',
    text: 'why',
    media: [],
    voiceReply: false,
    grillMe: false,
    receivedAt: Date.now(),
  });

  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(adapter.sent.length, 1);
  assert.match(adapter.sent[0].reply.text, /Fehler bei firecrawl/);
  assert.match(adapter.sent[0].reply.text, /boom/);
});