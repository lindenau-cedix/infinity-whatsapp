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

test('photo with downloadMedia() returning undefined does NOT crash route()', async () => {
  // INFA-27 regression: whatsapp-web.js downloadMedia() resolves to
  // `undefined` (not throws) in three real cases — late re-classification,
  // mediaStage still FETCHING, store entry not hydrated. The pre-fix
  // behavior was to feed that undefined into MediaStore.persist, which
  // dereferenced `.data` and threw "Cannot read properties of undefined
  // (reading 'data')". That crashed the whole route() chain and the
  // operator saw only `wa.message.failed`. After the fix the photo is
  // logged once as `media.unavailable` and the text branch still flows.
  const groups = makeGroups();
  const runtime = makeRuntime();
  const adapter = new WWebJsAdapter(groups, runtime, stubMedia);

  const sent = [];
  adapter.sendReply = async (jid, reply) => { sent.push({ jid, text: reply.text }); };

  const factory = () => ({
    name: 'qwenCode',
    run: async (text) => ({ text: `echo:${text}`, mediaRefs: [] }),
  });

  const dispatcher = new Dispatcher(adapter, factory, new Logger('test', 'info'));
  dispatcher.bind();

  let messageHandler = null;
  adapter.client = {
    on: (event, cb) => { if (event === 'message') messageHandler = cb; },
    getChats: () => Promise.resolve([]),
  };
  adapter.attachMessageStream();

  // Photo with a real id, real caption, real hasMedia:true — but
  // downloadMedia() resolves to undefined (the wwebjs store entry
  // hydration race). This is the exact shape the operator's log showed.
  await new Promise((resolve) => {
    assert.doesNotThrow(() => messageHandler({
      id: { id: 'photo.001', _serialized: 'photo.001' },
      from: 'real-qwen@g.us',
      author: 'sender@c.us',
      body: 'hello',
      hasMedia: true,
      downloadMedia: () => Promise.resolve(undefined),
      type: 'image',
    }));
    setTimeout(resolve, 200);
  });

  // Must produce exactly one reply — the text branch carries on.
  assert.equal(sent.length, 1, 'unavailable-media photo must still produce a reply');
  assert.equal(sent[0].jid, 'real-qwen@g.us');
  assert.equal(sent[0].text, 'echo:hello');

  try { fs.rmSync(runtime.sessionPath, { recursive: true, force: true }); } catch {}
});

test('photo with MessageMedia whose data is undefined does NOT crash route()', async () => {
  // Same shape as above but the page-eval returned a populated MessageMedia
  // whose `.data` is undefined. Pre-fix this still crashed at
  // `Buffer.from(media.data, "base64")` in MediaStore.persist.
  const groups = makeGroups();
  const runtime = makeRuntime();
  const adapter = new WWebJsAdapter(groups, runtime, stubMedia);

  const sent = [];
  adapter.sendReply = async (jid, reply) => { sent.push({ jid, text: reply.text }); };

  const factory = () => ({
    name: 'qwenCode',
    run: async (text) => ({ text: `echo:${text}`, mediaRefs: [] }),
  });

  const dispatcher = new Dispatcher(adapter, factory, new Logger('test', 'info'));
  dispatcher.bind();

  let messageHandler = null;
  adapter.client = {
    on: (event, cb) => { if (event === 'message') messageHandler = cb; },
    getChats: () => Promise.resolve([]),
  };
  adapter.attachMessageStream();

  await new Promise((resolve) => {
    assert.doesNotThrow(() => messageHandler({
      id: { id: 'photo.002', _serialized: 'photo.002' },
      from: 'real-qwen@g.us',
      author: 'sender@c.us',
      body: 'world',
      hasMedia: true,
      // Mimic whatsapp-web.js MessageMedia: the object exists but `.data`
      // was never populated (e.g. a 404 during decrypt that returned a
      // shell object instead of throwing).
      downloadMedia: () => Promise.resolve({ data: undefined, mimetype: 'image/jpeg', filename: 'x.jpg' }),
      type: 'image',
    }));
    setTimeout(resolve, 200);
  });

  assert.equal(sent.length, 1, 'data-undefined photo must still produce a reply');
  assert.equal(sent[0].text, 'echo:world');

  try { fs.rmSync(runtime.sessionPath, { recursive: true, force: true }); } catch {}
});

test('image-only message (no body, real persisted media) reaches the dispatcher with a media prompt', async () => {
  // INFA-27 follow-up regression: an operator sending a bare image with no
  // caption used to land at the dispatcher with msg.text="" which made the
  // Integrator throw `dispatch: prompt must be a non-empty string` and the
  // operator saw "Fehler bei qwenCode: ..." in WhatsApp. The fix builds a
  // fallback prompt "Analyse this media: [PATH]" from the saved paths, so
  // the qwen analyser dispatch chain has a non-empty prompt to invoke.
  const groups = makeGroups();
  const runtime = makeRuntime();
  const adapter = new WWebJsAdapter(groups, runtime, stubMedia);

  // Real-shape media store: persist returns the absolute path that the
  // MediaStore contract promises. The dispatcher must hand that exact
  // path to the adapter inside the fallback prompt.
  const realMedia = {
    init: async () => {},
    persist: async (transportId, index, _att, kind) => ({
      path: `/tmp/inbox/${transportId}-${index}.jpg`,
      mime: 'image/jpeg',
      kind,
    }),
  };
  const freshAdapter = new WWebJsAdapter(groups, runtime, realMedia);

  let capturedPrompt = null;
  let capturedMediaPaths = null;
  const sent = [];
  freshAdapter.sendReply = async (jid, reply) => {
    sent.push({ jid, text: reply.text });
  };

  const factory = () => ({
    name: 'qwenCode',
    run: async (text, ctx) => {
      capturedPrompt = text;
      capturedMediaPaths = ctx.mediaPaths;
      return { text: `analyzed:${text}`, mediaRefs: [] };
    },
  });

  const dispatcher = new Dispatcher(freshAdapter, factory, new Logger('test', 'info'));
  dispatcher.bind();

  let messageHandler = null;
  freshAdapter.client = {
    on: (event, cb) => { if (event === 'message') messageHandler = cb; },
    getChats: () => Promise.resolve([]),
  };
  freshAdapter.attachMessageStream();

  await new Promise((resolve) => {
    messageHandler({
      id: { id: 'img.001', _serialized: 'img.001' },
      from: 'real-qwen@g.us',
      author: 'sender@c.us',
      body: '',
      hasMedia: true,
      downloadMedia: () => Promise.resolve({ data: 'AAAA', mimetype: 'image/jpeg', filename: 'pic.jpg' }),
      type: 'image',
    });
    setTimeout(resolve, 200);
  });

  assert.equal(sent.length, 1, 'image-only message must reach the dispatcher');
  assert.ok(capturedPrompt, 'the adapter must have been called');
  assert.ok(
    capturedPrompt.startsWith('Analyse this media:'),
    `prompt must be a media-analysis prompt, got: ${capturedPrompt}`,
  );
  assert.ok(
    capturedPrompt.includes('/tmp/inbox/img.001-0.jpg'),
    `prompt must reference the persisted media path, got: ${capturedPrompt}`,
  );
  assert.deepEqual(capturedMediaPaths, ['/tmp/inbox/img.001-0.jpg']);

  try { fs.rmSync(runtime.sessionPath, { recursive: true, force: true }); } catch {}
});

test('image-only message: empty text + empty media does not pass an empty prompt', async () => {
  // Belt-and-braces: if for any reason both text and media arrays end up
  // empty by the time the dispatcher runs (a future regression), we must
  // not pass an empty string to the Integrator (which would still reject
  // with the same "prompt must be a non-empty string" error). The fix
  // substitutes a clear placeholder instead.
  const groups = makeGroups();
  const runtime = makeRuntime();
  const adapter = new WWebJsAdapter(groups, runtime, stubMedia);

  let capturedPrompt = null;
  adapter.sendReply = async () => {};

  const factory = () => ({
    name: 'qwenCode',
    run: async (text) => {
      capturedPrompt = text;
      return { text: `echo:${text}`, mediaRefs: [] };
    },
  });

  const dispatcher = new Dispatcher(adapter, factory, new Logger('test', 'info'));
  dispatcher.bind();

  let messageHandler = null;
  adapter.client = {
    on: (event, cb) => { if (event === 'message') messageHandler = cb; },
    getChats: () => Promise.resolve([]),
  };
  adapter.attachMessageStream();

  // Synthesize a message that passes isRoutable (hasMedia=true) but
  // collectAttachments returns [] (downloadMedia resolves to undefined).
  // text is also empty. This used to crash at the Integrator boundary.
  await new Promise((resolve) => {
    messageHandler({
      id: { id: 'img.002', _serialized: 'img.002' },
      from: 'real-qwen@g.us',
      author: 'sender@c.us',
      body: '',
      hasMedia: true,
      downloadMedia: () => Promise.resolve(undefined),
      type: 'image',
    });
    setTimeout(resolve, 200);
  });

  assert.ok(capturedPrompt !== null, 'adapter.run must have been called');
  assert.ok(
    capturedPrompt.length > 0,
    `adapter.run must not receive an empty prompt, got: "${capturedPrompt}"`,
  );

  try { fs.rmSync(runtime.sessionPath, { recursive: true, force: true }); } catch {}
});
