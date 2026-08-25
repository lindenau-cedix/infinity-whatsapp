'use strict';

// End-to-end smoke: drives the compiled dist/ with a fake WhatsApp adapter
// but the REAL Integrator factory from `endpoints-integrator/register.js`.
// Confirms that the wiring INFA-18 introduces produces real adapter
// dispatch calls per group instead of the old `[stub:…]` placeholder.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Dispatcher } = require('../dist/dispatcher.js');
const { Logger } = require('../dist/logger.js');

// Real register.js installs globalThis.INFINITY_INTEGRATOR_ADAPTERS as a
// side-effect. We require it before constructing the dispatcher.
require('../../endpoints-integrator/register.js');
const factory = globalThis.INFINITY_INTEGRATOR_ADAPTERS;
assert.ok(factory, 'Integrator register.js must install INFINITY_INTEGRATOR_ADAPTERS');

// Real adapter names per the Integrator's contract.
const SUPPORTED = ['qwenCode', 'perplexityReasoning', 'perplexityDeepResearch', 'firecrawl'];

function makeGroup(endpoint, jid) {
  return { jid, label: endpoint, endpoint };
}

class FakeAdapter {
  constructor(groups) {
    this.groups = groups;
    this.sent = [];
    this.handlers = [];
  }
  start() { return Promise.resolve(); }
  stop() { return Promise.resolve(); }
  onMessage(h) { this.handlers.push(h); }
  onEvent() {}
  getStatus() { return { state: 'ready' }; }
  sendReply(jid, reply) {
    this.sent.push({ jid, reply });
    return Promise.resolve();
  }
  emit(msg) {
    for (const h of this.handlers) h(msg);
  }
}

function makeGroups() {
  return {
    qwenCode: makeGroup('qwenCode', 'g-qwen@g.us'),
    perplexityReasoning: makeGroup('perplexityReasoning', 'g-rp@g.us'),
    perplexityDeepResearch: makeGroup('perplexityDeepResearch', 'g-dr@g.us'),
    firecrawl: makeGroup('firecrawl', 'g-fc@g.us'),
  };
}

test('register.js installs a factory that returns real adapters for every endpoint', () => {
  for (const name of SUPPORTED) {
    const a = factory(name);
    assert.equal(typeof a.run, 'function');
    assert.equal(a.name, name);
  }
});

test('Dispatching through the real factory for every group invokes the real adapter, never [stub:…]', async () => {
  const groups = makeGroups();
  const adapter = new FakeAdapter(groups);
  const dispatcher = new Dispatcher(adapter, factory, new Logger('smoke-real', 'silent'));
  dispatcher.bind();

  // Snapshot which adapters the factory returns for each name, and which
  // dispatch-key each one corresponds to (per register.js). This proves
  // that the *real* wrapper is what the dispatcher is calling.
  const adapterFor = {};
  for (const name of SUPPORTED) {
    adapterFor[name] = factory(name);
    assert.equal(adapterFor[name].name, name);
    assert.equal(typeof adapterFor[name].run, 'function');
  }

  // Now drive one message through each group. The real adapters may fail
  // because no API keys are configured in this CI environment — that is
  // fine. We only care that:
  //   (a) one reply is produced per group, and
  //   (b) no reply starts with `[stub:` (the INFA-18 stub marker).
  // A real adapter that errors out surfaces a `Fehler bei <name>: …` reply;
  // a real adapter that succeeds returns its own text. Either way, the
  // presence of `[stub:` would mean the factory never installed — i.e. the
  // wiring is broken.
  for (const [name, group] of Object.entries(groups)) {
    adapter.emit({
      transportId: `t-${name}`,
      group,
      authorId: 'user@x',
      text: 'hello',
      media: [],
      voiceReply: false,
      grillMe: false,
      receivedAt: Date.now(),
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }

  assert.equal(adapter.sent.length, SUPPORTED.length,
    `expected one reply per group, got ${adapter.sent.length}`);

  for (const reply of adapter.sent) {
    const text = reply.reply.text || '';
    assert.ok(
      !text.startsWith('[stub:'),
      `group ${reply.jid} returned the INFA-18 stub text "${text}" — wiring is broken`,
    );
  }

  // At least one group must have produced a non-empty, non-error response
  // OR a localized "Fehler bei <name>: …" error reply — both prove the
  // dispatcher called the real adapter, not the stub.
  const realOrError = adapter.sent.every((r) =>
    (r.reply.text && r.reply.text.length > 0) || /Fehler bei /.test(r.reply.text || ''),
  );
  assert.ok(realOrError,
    'every group must have produced a real adapter response or a localized error');
});