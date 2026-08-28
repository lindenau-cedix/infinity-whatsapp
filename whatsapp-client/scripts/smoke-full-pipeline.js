'use strict';

// INFA-27 follow-up regression: end-to-end pipeline smoke.
//
// The previous regression test (`smoke-jid-routing.js`) only exercised
// `route()` in isolation. The user reported "I dont know what you have
// done, but now I dont get any reaction on messages in the groups at
// all" after the isRoutable relaxation landed. To find the regression
// we need to drive the *full* pipeline: real-shape inbound wwebjs
// message → isRoutable → route() → IngressMessage → Dispatcher.handle()
// → Integrator adapter → adapter.sendReply(). That covers the gap
// between "router received it" and "we actually replied".

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { WWebJsAdapter } = require('../dist/wwebjsAdapter.js');
const { Dispatcher } = require('../dist/dispatcher.js');
const { Logger } = require('../dist/logger.js');

function makeGroups() {
  return {
    qwenCode: { jid: 'real-qwen@g.us', label: 'Qwen', endpoint: 'qwenCode' },
    perplexityReasoning: { jid: 'real-rp@g.us', label: 'PerpRP', endpoint: 'perplexityReasoning' },
    perplexityDeepResearch: { jid: 'real-dr@g.us', label: 'PerpDR', endpoint: 'perplexityDeepResearch' },
    firecrawl: { jid: 'real-fc@g.us', label: 'FC', endpoint: 'firecrawl' },
  };
}

function makeRuntime() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-smoke-full-'));
  return {
    sessionPath: tmp,
    headless: true,
    mediaDir: tmp,
    logLevel: 'info',
  };
}

const stubMedia = {
  init: async () => {},
  persist: async () => ({ path: '/tmp/x', mime: 'text/plain', kind: 'document' }),
};

test('a plain text message in a configured group reaches the dispatcher and a reply is sent', async () => {
  const groups = makeGroups();
  const runtime = makeRuntime();
  const adapter = new WWebJsAdapter(groups, runtime, stubMedia);

  // Intercept sendReply BEFORE bind() so we capture whatever the dispatcher
  // tries to send back. This is the end-state the user cares about.
  const sent = [];
  const origSend = adapter.sendReply.bind(adapter);
  adapter.sendReply = async (jid, reply) => {
    sent.push({ jid, reply });
    return origSend(jid, reply);
  };

  // Stub the Integrator factory with a fake that just echoes back.
  const fakeAdapter = {
    name: 'qwenCode',
    run: async (text, ctx) => ({
      text: `echo:${text}`,
      mediaRefs: [],
      usage: { latencyMs: 1 },
    }),
  };
  const factory = (endpoint) => {
    if (endpoint !== 'qwenCode') throw new Error(`unexpected endpoint ${endpoint}`);
    return fakeAdapter;
  };

  const dispatcher = new Dispatcher(adapter, factory, new Logger('test', 'info'));
  dispatcher.bind();

  // Wire a fake wwebjs client so we can drive attachMessageStream().
  let messageHandler = null;
  adapter.client = {
    on: (event, cb) => { if (event === 'message') messageHandler = cb; },
    getChats: () => Promise.resolve([]),
  };
  adapter.attachMessageStream();

  // Push a real-shape normal text message through.
  await new Promise((resolve) => {
    messageHandler({
      id: { id: 'true.001', _serialized: 'true.001' },
      from: 'real-qwen@g.us',
      author: 'sender@c.us',
      body: 'hello qwen',
      hasMedia: false,
      type: 'chat',
    });
    // The dispatcher async chain settles within a few ms; wait a bit to
    // be deterministic in CI.
    setTimeout(resolve, 200);
  });

  assert.equal(sent.length, 1, 'the dispatcher should have called sendReply exactly once');
  assert.equal(sent[0].jid, 'real-qwen@g.us');
  assert.equal(sent[0].reply.text, 'echo:hello qwen');

  try { fs.rmSync(runtime.sessionPath, { recursive: true, force: true }); } catch {}
});

test('all four configured groups still reply after the isRoutable relaxation', async () => {
  const groups = makeGroups();
  const runtime = makeRuntime();
  const adapter = new WWebJsAdapter(groups, runtime, stubMedia);

  const sent = [];
  adapter.sendReply = async (jid, reply) => { sent.push({ jid, text: reply.text }); };

  const fakeFactory = (endpoint) => ({
    name: endpoint,
    run: async (text) => ({ text: `ok:${endpoint}`, mediaRefs: [] }),
  });

  const dispatcher = new Dispatcher(adapter, fakeFactory, new Logger('test', 'info'));
  dispatcher.bind();

  let messageHandler = null;
  adapter.client = {
    on: (event, cb) => { if (event === 'message') messageHandler = cb; },
    getChats: () => Promise.resolve([]),
  };
  adapter.attachMessageStream();

  const cases = [
    { jid: 'real-qwen@g.us', label: 'qwenCode', body: 'ping qwen' },
    { jid: 'real-rp@g.us', label: 'PerpRP', body: 'ping rp' },
    { jid: 'real-dr@g.us', label: 'PerpDR', body: 'ping dr' },
    { jid: 'real-fc@g.us', label: 'FC', body: 'ping fc' },
  ];

  await new Promise((resolve) => {
    for (const c of cases) {
      messageHandler({
        id: { id: `t:${c.jid}`, _serialized: `t:${c.jid}` },
        from: c.jid,
        author: 'sender@c.us',
        body: c.body,
        hasMedia: false,
        type: 'chat',
      });
    }
    setTimeout(resolve, 300);
  });

  assert.equal(sent.length, 4, `expected 4 replies, got ${sent.length}: ${JSON.stringify(sent)}`);
  const jids = sent.map((s) => s.jid).sort();
  assert.deepEqual(jids, cases.map((c) => c.jid).sort());

  try { fs.rmSync(runtime.sessionPath, { recursive: true, force: true }); } catch {}
});

test('id-less image messages also reach the dispatcher after the relaxation', async () => {
  const groups = makeGroups();
  const runtime = makeRuntime();
  const adapter = new WWebJsAdapter(groups, runtime, stubMedia);

  const sent = [];
  adapter.sendReply = async (jid, reply) => { sent.push({ jid, text: reply.text }); };

  const factory = () => ({
    name: 'qwenCode',
    run: async (text) => ({ text: `analyzed:${text}`, mediaRefs: [] }),
  });

  const dispatcher = new Dispatcher(adapter, factory, new Logger('test', 'info'));
  dispatcher.bind();

  let messageHandler = null;
  adapter.client = {
    on: (event, cb) => { if (event === 'message') messageHandler = cb; },
    getChats: () => Promise.resolve([]),
  };
  adapter.attachMessageStream();

  // Pure-media image with no id, no body — the original INFA-27 incident.
  await new Promise((resolve) => {
    assert.doesNotThrow(() => messageHandler({
      from: 'real-qwen@g.us',
      author: 'sender@c.us',
      hasMedia: true,
      type: 'image',
    }));
    setTimeout(resolve, 200);
  });

  // Note: collectAttachments returns [] when downloadMedia is undefined,
  // so the Integrator sees an empty mediaPaths. The dispatcher still
  // produces a reply; the qwenMedia dispatch branch is what would inject
  // the path, but that's a downstream concern.
  assert.equal(sent.length, 1, 'id-less image must reach the dispatcher');
  assert.equal(sent[0].jid, 'real-qwen@g.us');

  try { fs.rmSync(runtime.sessionPath, { recursive: true, force: true }); } catch {}
});
