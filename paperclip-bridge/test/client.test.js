// =============================================================================
// PaperclipClient tests with mocked HTTP.
//
// Uses node:test (Node 18+). Each test gets a fresh `mockFetch` that records
// requests and returns scripted responses.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PaperclipClient,
  renderEventBody,
} from "../src/client.js";
import {
  PaperclipAuthError,
  PaperclipTransientError,
  PaperclipProtocolError,
} from "../src/errors.js";

// --- test fixtures ----------------------------------------------------------

function makeFetch(scripts) {
  const calls = [];
  let i = 0;
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const script = scripts[Math.min(i, scripts.length - 1)];
    i++;
    if (typeof script === "function") return script(url, init);
    return script;
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(status, text) {
  return new Response(text, { status, headers: { "content-type": "text/plain" } });
}

const ISSUE_ID = "00467aa7-d71d-4cb3-9704-73a28ce4f4c0";

function makeClient(overrides = {}) {
  return new PaperclipClient({
    apiKey: "test-key",
    apiUrl: "http://localhost:3100/api",
    companyId: "co-1",
    agentId: "agent-1",
    runId: "run-1",
    ratePerSecond: 1000,
    burst: 1000,
    fetchTimeoutMs: 5000,
    ...overrides,
  });
}

// --- whoami -----------------------------------------------------------------

test("whoami: returns parsed body on 200", async () => {
  const fetchImpl = makeFetch([jsonResponse(200, { id: "agent-1" })]);
  const c = makeClient({ fetch: fetchImpl });
  const me = await c.whoami();
  assert.equal(me.id, "agent-1");
  assert.equal(fetchImpl.calls.length, 1);
  const [call] = fetchImpl.calls;
  assert.equal(call.url, "http://localhost:3100/api/agents/me");
  assert.equal(call.init.headers.Authorization, "Bearer test-key");
  assert.equal(call.init.headers["X-Paperclip-Agent-Id"], "agent-1");
  assert.equal(call.init.headers["X-Paperclip-Run-Id"], "run-1");
});

test("whoami: 401 → PaperclipAuthError, no silent retry", async () => {
  const c = makeClient({
    fetch: makeFetch([jsonResponse(401, { error: "bad key" })]),
  });
  await assert.rejects(c.whoami(), (e) => {
    assert.ok(e instanceof PaperclipAuthError);
    assert.equal(e.code, "paperclip_auth");
    assert.equal(e.status, 401);
    return true;
  });
});

// --- createIssue -----------------------------------------------------------

test("createIssue: POSTs to /api/companies/{id}/issues with title+description", async () => {
  const fetchImpl = makeFetch([
    jsonResponse(201, { id: ISSUE_ID, identifier: "INFA-99" }),
  ]);
  const c = makeClient({ fetch: fetchImpl });
  const out = await c.createIssue({
    title: "Bridge: handle poll.created",
    body: "auto-mirror polls as comments",
    parentId: "p-1",
  });
  assert.equal(out.id, ISSUE_ID);
  const [call] = fetchImpl.calls;
  assert.equal(call.url, "http://localhost:3100/api/companies/co-1/issues");
  assert.equal(call.init.method, "POST");
  const payload = JSON.parse(call.init.body);
  assert.equal(payload.title, "Bridge: handle poll.created");
  assert.equal(payload.description, "auto-mirror polls as comments");
  assert.equal(payload.parentId, "p-1");
});

test("createIssue: throws if response lacks id", async () => {
  const c = makeClient({
    fetch: makeFetch([jsonResponse(201, { identifier: "INFA-99" })]),
  });
  await assert.rejects(c.createIssue({ title: "x" }), (e) => {
    assert.ok(e instanceof PaperclipProtocolError);
    return true;
  });
});

test("createIssue: missing companyId → protocol error, no HTTP", async () => {
  const fetchImpl = makeFetch([]);
  const c = new PaperclipClient({
    apiKey: "k",
    apiUrl: "http://localhost:3100/api",
    // intentionally omit companyId AND ensure no env fallback
    agentId: null,
    runId: null,
    ratePerSecond: 1000,
    burst: 1000,
    fetch: fetchImpl,
    fetchTimeoutMs: 5000,
  });
  // Force-clear in case test env has PAPERCLIP_COMPANY_ID exported.
  c.companyId = null;
  await assert.rejects(c.createIssue({ title: "x" }), (e) => {
    assert.ok(e instanceof PaperclipProtocolError);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 0);
});

// --- comment ---------------------------------------------------------------

test("comment: POSTs body to /api/issues/{id}/comments", async () => {
  const fetchImpl = makeFetch([
    jsonResponse(201, { id: "c-1", body: "hello" }),
  ]);
  const c = makeClient({ fetch: fetchImpl });
  const out = await c.comment(ISSUE_ID, "hello");
  assert.equal(out.id, "c-1");
  const [call] = fetchImpl.calls;
  assert.equal(call.url, `http://localhost:3100/api/issues/${ISSUE_ID}/comments`);
  assert.equal(call.init.method, "POST");
  assert.deepEqual(JSON.parse(call.init.body), { body: "hello" });
});

test("comment: 403 → PaperclipAuthError", async () => {
  const c = makeClient({
    fetch: makeFetch([jsonResponse(403, { error: "no scope" })]),
  });
  await assert.rejects(c.comment(ISSUE_ID, "x"), (e) => {
    assert.ok(e instanceof PaperclipAuthError);
    return true;
  });
});

// --- logEvent (idempotency, default policy) --------------------------------

test("logEvent: explicit issueId posts a comment", async () => {
  const fetchImpl = makeFetch([
    jsonResponse(201, { id: "c-2" }),
  ]);
  const c = makeClient({ fetch: fetchImpl });
  const out = await c.logEvent({
    kind: "message.received",
    group: "Qwen",
    messageId: "msg-1",
    issueId: ISSUE_ID,
  });
  assert.equal(out.status, "commented");
  assert.equal(out.issueId, ISSUE_ID);
  // one HTTP call
  assert.equal(fetchImpl.calls.length, 1);
});

test("logEvent: missing issueId and no createNew → skipped, no HTTP", async () => {
  const fetchImpl = makeFetch([]);
  const c = makeClient({ fetch: fetchImpl });
  const out = await c.logEvent({
    kind: "message.received",
    group: "Qwen",
    messageId: "msg-2",
  });
  assert.equal(out.status, "skipped");
  assert.equal(fetchImpl.calls.length, 0);
});

test("logEvent: idempotent on duplicate (group, messageId, kind) within TTL", async () => {
  const fetchImpl = makeFetch([jsonResponse(201, { id: "c-3" })]);
  const c = makeClient({
    fetch: fetchImpl,
    idempotencyTtlMs: 60_000,
  });
  const ev = {
    kind: "message.received",
    group: "Qwen",
    messageId: "msg-dup",
    issueId: ISSUE_ID,
  };
  const a = await c.logEvent(ev);
  const b = await c.logEvent(ev);
  assert.equal(a.status, "commented");
  assert.equal(b.status, "duplicate");
  assert.equal(fetchImpl.calls.length, 1);
});

test("logEvent: 429 → PaperclipTransientError", async () => {
  const c = makeClient({
    fetch: makeFetch([jsonResponse(429, { error: "slow down" })]),
  });
  await assert.rejects(
    c.logEvent({
      kind: "message.received",
      group: "Qwen",
      messageId: "msg-429",
      issueId: ISSUE_ID,
    }),
    (e) => {
      assert.ok(e instanceof PaperclipTransientError);
      assert.equal(e.status, 429);
      return true;
    },
  );
});

test("logEvent: 500 → PaperclipTransientError", async () => {
  const c = makeClient({
    fetch: makeFetch([textResponse(500, "boom")]),
  });
  await assert.rejects(
    c.logEvent({
      kind: "message.received",
      group: "Qwen",
      messageId: "msg-500",
      issueId: ISSUE_ID,
    }),
    (e) => {
      assert.ok(e instanceof PaperclipTransientError);
      assert.equal(e.status, 500);
      return true;
    },
  );
});

test("logEvent: 400 → PaperclipProtocolError (not transient, not auth)", async () => {
  const c = makeClient({
    fetch: makeFetch([jsonResponse(400, { error: "bad payload" })]),
  });
  await assert.rejects(
    c.logEvent({
      kind: "message.received",
      group: "Qwen",
      messageId: "msg-400",
      issueId: ISSUE_ID,
    }),
    (e) => {
      assert.ok(e instanceof PaperclipProtocolError);
      assert.equal(e.status, 400);
      return true;
    },
  );
});

test("logEvent: malformed JSON success → PaperclipProtocolError", async () => {
  const c = makeClient({
    fetch: makeFetch([
      new Response("not json {", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ]),
  });
  await assert.rejects(
    c.logEvent({
      kind: "message.received",
      group: "Qwen",
      messageId: "msg-bad",
      issueId: ISSUE_ID,
    }),
    (e) => {
      assert.ok(e instanceof PaperclipProtocolError);
      return true;
    },
  );
});

// --- renderEventBody -------------------------------------------------------

test("renderEventBody: message.received includes group + messageId + preview", () => {
  const body = renderEventBody({
    kind: "message.received",
    group: "Qwen",
    messageId: "m-1",
    preview: "hello world",
    adapterId: "qwenCode",
  });
  assert.match(body, /message\.received/);
  assert.match(body, /group.*Qwen/);
  assert.match(body, /m-1/);
  assert.match(body, /qwenCode/);
});

test("renderEventBody: poll.created lists option count", () => {
  const body = renderEventBody({
    kind: "poll.created",
    group: "Perp. RP",
    pollId: "p-1",
    header: "Klärung",
    options: ["a", "b", "c"],
  });
  assert.match(body, /poll\.created/);
  assert.match(body, /\(3\)/);
});

test("renderEventBody: error folds stack into <details>", () => {
  const body = renderEventBody({
    kind: "error",
    group: "Qwen",
    messageId: "m-2",
    message: "kaboom",
    stack: "Error: kaboom\n  at x",
  });
  assert.match(body, /kaboom/);
  assert.match(body, /<details>/);
});

// --- header propagation ----------------------------------------------------

test("emits X-Paperclip-Run-Id and X-Paperclip-Agent-Id on POST", async () => {
  const fetchImpl = makeFetch([jsonResponse(201, { id: "c-4" })]);
  const c = makeClient({ fetch: fetchImpl });
  await c.comment(ISSUE_ID, "hi");
  const [call] = fetchImpl.calls;
  assert.equal(call.init.headers["X-Paperclip-Agent-Id"], "agent-1");
  assert.equal(call.init.headers["X-Paperclip-Run-Id"], "run-1");
});

// --- api-key gate ----------------------------------------------------------

test("missing API key → PaperclipAuthError at construction time", () => {
  assert.throws(
    () => new PaperclipClient({ apiKey: "", apiUrl: "http://x/api" }),
    (e) => {
      assert.ok(e instanceof PaperclipAuthError);
      return true;
    },
  );
});