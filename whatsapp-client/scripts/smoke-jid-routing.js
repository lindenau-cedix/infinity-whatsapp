'use strict';

// Smoke test for INFA-20 JID-routing behavior.
//
// Verifies two things that the previous heartbeat missed:
//   1. A WA message whose chat JID is not in the configured group registry
//      is logged at info level ("wa.message.ignored_no_group") instead of
//      silently disappearing. This is the direct fix for the user's symptom:
//      "only the qwen messages appear in the log".
//   2. Messages from a configured group DO reach the dispatcher / handler
//      chain — proves the new log line didn't accidentally break routing.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Capture structured-log lines by intercepting process.stdout.write (the
// production Logger writes JSON lines there) and parsing each line. This
// is what an external log collector would do in production; using it here
// means we exercise the actual logger code path end-to-end.
function makeCapturingLogger() {
  // Kept as a thin no-op alias for clarity; the actual capture happens in
  // withCapture() via the shared _activeEntries list.
  return { entries: _activeEntries };
}

// Shared list of captured lines, populated by withCapture(). Tests assert
// against this directly via entriesMatching() so they read like normal
// JSON-log assertions.
let _activeEntries = [];
function withCapture(fn) {
  // Reset the shared buffer so each test starts fresh — without this,
  // a previous test's log lines leak into the next test's assertions.
  _activeEntries.length = 0;
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (const line of s.split(/\r?\n/)) {
      if (!line) continue;
      try {
        _activeEntries.push(JSON.parse(line));
      } catch {
        // Non-JSON; ignore.
      }
    }
    return orig(chunk, ...rest);
  };
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = orig;
  });
}
function entriesMatching(predicate) {
  return _activeEntries.filter(predicate);
}

// We need to construct a real WWebJsAdapter and trigger its 'message' event
// listener. The simplest way is to require the compiled dist/ directly,
// then poke the message-handler wiring the same way the WA client would.
const { WWebJsAdapter } = require('../dist/wwebjsAdapter.js');

// A no-op MediaStore stub — collectAttachments short-circuits when
// hasMedia is false, so we don't need a real filesystem-backed store.
const stubMedia = {
  init: () => Promise.resolve(),
  persist: () => Promise.resolve({ path: '/tmp/x', mime: 'text/plain', kind: 'document' }),
};

function makeGroups() {
  return {
    qwenCode: { jid: 'real-qwen@g.us', label: 'Qwen', endpoint: 'qwenCode' },
    perplexityReasoning: { jid: 'real-rp@g.us', label: 'PerpRP', endpoint: 'perplexityReasoning' },
    perplexityDeepResearch: { jid: 'real-dr@g.us', label: 'PerpDR', endpoint: 'perplexityDeepResearch' },
    firecrawl: { jid: 'real-fc@g.us', label: 'FC', endpoint: 'firecrawl' },
  };
}

function makeRuntime() {
  // Use a throwaway sessionPath so we never touch a real WA bundle.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-smoke-'));
  return {
    sessionPath: tmp,
    headless: true,
    mediaDir: tmp,
    logLevel: 'info',
  };
}

test('messages with a JID that does not match any group emit a wa.message.ignored_no_group log line', async () => {
  const groups = makeGroups();
  const runtime = makeRuntime();
  const adapter = new WWebJsAdapter(groups, runtime, stubMedia);

  const routeFn = WWebJsAdapter.prototype['route'];

  await withCapture(async () => {
    // Message with an unknown JID — should be ignored with a log line.
    await routeFn.call(adapter, {
      id: { id: 'm1', _serialized: 'm1' },
      from: 'unknown@g.us',
      author: 'author@c.us',
      body: 'hello',
      hasMedia: false,
      type: 'chat',
    });
  });

  const ignoreEntries = entriesMatching((e) => e.msg === 'wa.message.ignored_no_group');
  assert.equal(
    ignoreEntries.length,
    1,
    `expected exactly one 'wa.message.ignored_no_group' log entry, got ${ignoreEntries.length}`,
  );
  assert.equal(ignoreEntries[0].level, 'info');
  assert.equal(ignoreEntries[0].from, 'unknown@g.us');
  assert.ok(Array.isArray(ignoreEntries[0].configuredJids));
  assert.equal(ignoreEntries[0].configuredJids.length, 4);

  // Cleanup.
  try { fs.rmSync(runtime.sessionPath, { recursive: true, force: true }); } catch {}
});

test('messages with a JID that matches a configured group route through without the ignored_no_group log', async () => {
  const groups = makeGroups();
  const runtime = makeRuntime();
  const adapter = new WWebJsAdapter(groups, runtime, stubMedia);

  const routedMessages = [];
  adapter.onMessage((m) => { routedMessages.push(m); });

  const routeFn = WWebJsAdapter.prototype['route'];

  await withCapture(async () => {
    await routeFn.call(adapter, {
      id: { id: 'm2', _serialized: 'm2' },
      from: 'real-qwen@g.us',
      author: 'author@c.us',
      body: 'hello qwen',
      hasMedia: false,
      type: 'chat',
    });
  });

  assert.equal(routedMessages.length, 1);
  assert.equal(routedMessages[0].group.endpoint, 'qwenCode');
  assert.equal(routedMessages[0].text, 'hello qwen');

  const ignoredForMatch = entriesMatching(
    (e) => e.msg === 'wa.message.ignored_no_group' && e.from === 'real-qwen@g.us',
  );
  assert.equal(ignoredForMatch.length, 0, 'matched JID must not be logged as ignored');

  const ingressEntries = entriesMatching((e) => e.msg === 'ingress.message');
  assert.equal(ingressEntries.length, 1);
  assert.equal(ingressEntries[0].endpoint, 'qwenCode');

  try { fs.rmSync(runtime.sessionPath, { recursive: true, force: true }); } catch {}
});

test('validateConfiguredJids flags every configured endpoint whose JID is not in the joined-group list', async () => {
  const groups = makeGroups();
  const runtime = makeRuntime();
  const adapter = new WWebJsAdapter(groups, runtime, stubMedia);

  // Only Qwen is in the joined list — exactly the user-reported state.
  adapter.client = {
    getChats: () => Promise.resolve([
      { id: { _serialized: 'real-qwen@g.us' }, name: 'Qwen', subject: 'Qwen' },
      { id: { _serialized: 'some-other-group@g.us' }, name: 'Random', subject: 'Random' },
      { id: { _serialized: 'private@c.us' }, name: 'Self', subject: 'Self' },
    ]),
  };

  await withCapture(() => adapter['validateConfiguredJids']());

  const warnEntries = entriesMatching((e) => e.msg === 'wa.jid_validation.mismatch');
  assert.equal(warnEntries.length, 1, 'expected exactly one mismatch warning');
  const missing = warnEntries[0].missing;
  assert.equal(missing.length, 3, 'three endpoints should be flagged as missing');
  const endpoints = missing.map((m) => m.endpoint).sort();
  assert.deepEqual(endpoints, ['firecrawl', 'perplexityDeepResearch', 'perplexityReasoning']);
  assert.match(warnEntries[0].hint, /WA_GROUP_JID_/);

  try { fs.rmSync(runtime.sessionPath, { recursive: true, force: true }); } catch {}
});

test('validateConfiguredJids emits ok summary when every configured JID matches', async () => {
  const groups = makeGroups();
  const runtime = makeRuntime();
  const adapter = new WWebJsAdapter(groups, runtime, stubMedia);

  adapter.client = {
    getChats: () => Promise.resolve([
      { id: { _serialized: 'real-qwen@g.us' } },
      { id: { _serialized: 'real-rp@g.us' } },
      { id: { _serialized: 'real-dr@g.us' } },
      { id: { _serialized: 'real-fc@g.us' } },
      { id: { _serialized: 'extra@g.us' } },
    ]),
  };

  await withCapture(() => adapter['validateConfiguredJids']());

  const okEntries = entriesMatching((e) => e.msg === 'wa.jid_validation.ok');
  assert.equal(okEntries.length, 1);
  assert.equal(okEntries[0].matchedCount, 4);

  const mismatches = entriesMatching((e) => e.msg === 'wa.jid_validation.mismatch');
  assert.equal(mismatches.length, 0);

  try { fs.rmSync(runtime.sessionPath, { recursive: true, force: true }); } catch {}
});

// INFA-27 hardening — unparseable inbound payloads (notification /
// protocol-level messages that lack a populated id) must be dropped at
// info level, not surfaced as `wa.message.failed` with `error="r"`.
// We exercise the actual `client.on('message', …)` wiring by giving the
// adapter a fake client whose listener we invoke directly.
test('messages with no id, body, or media emit wa.message.ignored_unparseable and never reach the router', async () => {
  const groups = makeGroups();
  const runtime = makeRuntime();
  const adapter = new WWebJsAdapter(groups, runtime, stubMedia);

  let messageHandler = null;
  adapter.client = {
    on: (event, cb) => { if (event === 'message') messageHandler = cb; },
    getChats: () => Promise.resolve([]),
  };
  // Re-run attachMessageStream so it binds to our fake client.
  adapter['attachMessageStream']();

  const routed = [];
  adapter.onMessage((m) => { routed.push(m); });

  await withCapture(async () => {
    // wwebjs sometimes hands us a payload with no id, no body, no media.
    assert.doesNotThrow(() => messageHandler({
      from: 'real-qwen@g.us',
      hasMedia: false,
      type: 'notification',
    }));
    // And one without a `from` JID.
    assert.doesNotThrow(() => messageHandler({
      id: { id: 'x', _serialized: 'x' },
      hasMedia: false,
      type: 'chat',
    }));
    // A routable message still works after the ignored ones.
    assert.doesNotThrow(() => messageHandler({
      id: { id: 'ok', _serialized: 'ok' },
      from: 'real-qwen@g.us',
      author: 'author@c.us',
      body: 'hi qwen',
      hasMedia: false,
      type: 'chat',
    }));
  });

  const unparseable = entriesMatching((e) => e.msg === 'wa.message.ignored_unparseable');
  assert.equal(unparseable.length, 2, 'two unparseable payloads should be ignored');
  assert.equal(unparseable[0].level, 'info');
  assert.equal(unparseable[0].hasId, false);
  assert.equal(unparseable[0].hasBody, false);
  assert.equal(unparseable[1].from, null);

  // None of the ignored payloads must reach the router, but the routable
  // one does.
  assert.equal(routed.length, 1, 'only the routable payload should reach handlers');
  assert.equal(routed[0].text, 'hi qwen');

  // Critically: there should be NO `wa.message.failed` line for the
  // unparseable ones (the old symptom that masked real routing).
  const failed = entriesMatching((e) => e.msg === 'wa.message.failed' && e.error === 'r');
  assert.equal(failed.length, 0, 'unparseable payloads must not produce wa.message.failed');

  try { fs.rmSync(runtime.sessionPath, { recursive: true, force: true }); } catch {}
});