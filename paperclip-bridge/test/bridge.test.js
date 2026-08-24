// =============================================================================
// PaperclipBridge tests — two directions, mocked HTTP.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import { PaperclipBridge } from "../src/bridge.js";
import { PaperclipClient } from "../src/client.js";
import { PaperclipCommandError } from "../src/errors.js";

// --- helpers ---------------------------------------------------------------

function makeFetch(scripts) {
  const calls = [];
  let i = 0;
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const s = scripts[Math.min(i, scripts.length - 1)];
    i++;
    return typeof s === "function" ? s(url, init) : s;
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

const ISSUE_ID = "00467aa7-d71d-4cb3-9704-73a28ce4f4c0";
const ISSUE_ROW = {
  id: ISSUE_ID,
  identifier: "INFA-11",
  title: "Build Paperclip bridge integration",
  status: "in_progress",
  assigneeAgentId: "d3aca56a-6d2b-458b-ba94-3eeaa5fa69c6",
};

function makeBridge(opts = {}) {
  const fetchImpl = makeFetch(opts.fetchScripts ?? []);
  const client = new PaperclipClient({
    apiKey: "k",
    apiUrl: "http://localhost:3100/api",
    companyId: "co-1",
    agentId: "agent-1",
    runId: "run-1",
    ratePerSecond: 1000,
    burst: 1000,
    fetch: fetchImpl,
    ...opts.clientOverrides,
  });
  const bridge = new PaperclipBridge({
    client,
    defaultIssueId: opts.defaultIssueId,
    getIssue: opts.getIssue,
    silenceAuthErrors: opts.silenceAuthErrors,
  });
  return { bridge, client, fetchImpl };
}

// --- OUTBOUND --------------------------------------------------------------

test("emit: known kind with defaultIssueId posts a comment", async () => {
  const { bridge, fetchImpl } = makeBridge({
    defaultIssueId: ISSUE_ID,
    fetchScripts: [jsonResponse(201, { id: "c-1" })],
  });
  const out = await bridge.emit({
    kind: "message.received",
    group: "Qwen",
    messageId: "m-1",
  });
  assert.equal(out.status, "commented");
  assert.equal(out.issueId, ISSUE_ID);
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(
    fetchImpl.calls[0].url,
    new RegExp(`/api/issues/${ISSUE_ID}/comments$`),
  );
});

test("emit: poll.created event mirrors options into the comment body", async () => {
  const { bridge, fetchImpl } = makeBridge({
    defaultIssueId: ISSUE_ID,
    fetchScripts: [jsonResponse(201, { id: "c-1" })],
  });
  await bridge.emit({
    kind: "poll.created",
    group: "Perp. RP",
    pollId: "p-1",
    header: "Klärung",
    options: ["A", "B", "C"],
  });
  const body = JSON.parse(fetchImpl.calls[0].init.body).body;
  assert.match(body, /poll\.created/);
  assert.match(body, /\(3\)/);
  assert.match(body, /Klärung/);
});

test("emit: error event includes message + folded stack", async () => {
  const { bridge, fetchImpl } = makeBridge({
    defaultIssueId: ISSUE_ID,
    fetchScripts: [jsonResponse(201, { id: "c-1" })],
  });
  await bridge.emit({
    kind: "error",
    group: "Qwen",
    messageId: "m-2",
    message: "kaboom",
    stack: "Error: kaboom\n  at x",
  });
  const body = JSON.parse(fetchImpl.calls[0].init.body).body;
  assert.match(body, /kaboom/);
  assert.match(body, /<details>/);
});

test("emit: unknown kind is silently dropped, no HTTP", async () => {
  const { bridge, fetchImpl } = makeBridge({ defaultIssueId: ISSUE_ID });
  const out = await bridge.emit({ kind: "made.up.kind" });
  assert.equal(out.status, "unknown_kind");
  assert.equal(fetchImpl.calls.length, 0);
});

test("emit: auth error surfaced unless silenceAuthErrors", async () => {
  const { bridge, fetchImpl } = makeBridge({
    defaultIssueId: ISSUE_ID,
    fetchScripts: [
      jsonResponse(401, { error: "bad key" }),
    ],
  });
  await assert.rejects(bridge.emit({
    kind: "message.received",
    group: "Qwen",
    messageId: "m-1",
  }), (e) => e.code === "paperclip_auth");
  assert.equal(fetchImpl.calls.length, 1);
});

test("emit: auth error swallowed when silenceAuthErrors=true", async () => {
  const { bridge, fetchImpl } = makeBridge({
    defaultIssueId: ISSUE_ID,
    silenceAuthErrors: true,
    fetchScripts: [jsonResponse(401, { error: "bad key" })],
  });
  const out = await bridge.emit({
    kind: "message.received",
    group: "Qwen",
    messageId: "m-1",
  });
  assert.equal(out.status, "auth_error_silenced");
});

test("emitBatch: counts ok vs failed across mixed transient/auth events", async () => {
  const { bridge, fetchImpl } = makeBridge({
    defaultIssueId: ISSUE_ID,
    fetchScripts: [
      jsonResponse(201, { id: "c-1" }), // ok
      jsonResponse(500, "boom"),        // transient (still throws)
      jsonResponse(201, { id: "c-3" }), // ok
    ],
  });
  const out = await bridge.emitBatch([
    { kind: "message.received", group: "Qwen", messageId: "m-1" },
    { kind: "message.received", group: "Qwen", messageId: "m-2" },
    { kind: "message.received", group: "Qwen", messageId: "m-3" },
  ]);
  assert.equal(out.ok, 2);
  assert.equal(out.failed, 1);
  assert.equal(fetchImpl.calls.length, 3);
});

// --- INBOUND ---------------------------------------------------------------

test("handle: non-bridge message → handled:false", async () => {
  const { bridge } = makeBridge();
  const out = await bridge.handle("hello world", { group: "Qwen" });
  assert.deepEqual(out, { handled: false });
});

test("handle: /paperclip status looks up the issue and posts a comment", async () => {
  const { bridge, fetchImpl } = makeBridge({
    fetchScripts: [
      jsonResponse(200, ISSUE_ROW),                  // GET /api/issues/{id}
      jsonResponse(201, { id: "c-1" }),              // POST comment
    ],
  });
  const out = await bridge.handle("/paperclip status INFA-11", {
    group: "Qwen",
    messageId: "m-1",
  });
  assert.equal(out.handled, true);
  assert.match(out.reply, /^Paperclip:/);
  assert.match(out.reply, /INFA-11/);
  assert.match(out.reply, /in_progress/);
  assert.match(out.reply, /Build Paperclip bridge integration/);
  // Two HTTP calls: GET issue, POST comment
  assert.equal(fetchImpl.calls.length, 2);
  assert.match(fetchImpl.calls[0].url, /\/api\/issues\/INFA-11$/);
  assert.match(fetchImpl.calls[1].url, /\/comments$/);
});

test("handle: /paperclip status is idempotent on rapid repeat (60s)", async () => {
  const { bridge, fetchImpl } = makeBridge({
    fetchScripts: [
      jsonResponse(200, ISSUE_ROW),   // 1st call: GET issue
      jsonResponse(201, { id: "c-1" }), // 1st call: POST comment
      jsonResponse(200, ISSUE_ROW),   // 2nd call: GET issue
      // 2nd call should NOT POST comment — dedup hits inside logEvent
    ],
  });
  const ctx = { group: "Qwen", messageId: "m-rep" };
  await bridge.handle("/paperclip status INFA-11", ctx);
  const out2 = await bridge.handle("/paperclip status INFA-11", ctx);
  assert.equal(out2.handled, true);
  assert.ok(out2.paperclipEvent, "paperclipEvent must be defined");
  assert.equal(out2.paperclipEvent.status, "duplicate");
  // 1st call: GET + POST  → 2 calls
  // 2nd call: GET only    → 1 call
  // total = 3
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(fetchImpl.calls.filter(c => c.url.includes("/comments")).length, 1);
});

test("handle: /paperclip comment posts body, no extra fetch", async () => {
  const { bridge, fetchImpl } = makeBridge({
    fetchScripts: [
      jsonResponse(200, ISSUE_ROW),
      jsonResponse(201, { id: "c-1" }),
    ],
  });
  const out = await bridge.handle(
    "/paperclip comment INFA-11 please investigate",
    { group: "Qwen", messageId: "m-2" },
  );
  assert.equal(out.handled, true);
  assert.match(out.reply, /Kommentar/);
  const [, post] = fetchImpl.calls;
  assert.equal(JSON.parse(post.init.body).body, "please investigate");
});

test("handle: /paperclip new creates an issue", async () => {
  const { bridge, fetchImpl } = makeBridge({
    fetchScripts: [
      jsonResponse(201, { id: "new-1", identifier: "INFA-99" }),
    ],
  });
  const out = await bridge.handle(
    "/paperclip new Investigate webhook dedupe",
    { group: "Qwen", messageId: "m-3" },
  );
  assert.equal(out.handled, true);
  assert.match(out.reply, /neues Issue/);
  assert.match(out.reply, /INFA-99/);
  assert.equal(fetchImpl.calls[0].init.method, "POST");
  assert.match(fetchImpl.calls[0].url, /\/api\/companies\/co-1\/issues$/);
});

test("handle: /paperclip help returns usage", async () => {
  const { bridge } = makeBridge();
  const out = await bridge.handle("/paperclip help", { group: "Qwen" });
  assert.equal(out.handled, true);
  assert.match(out.reply, /Paperclip-Bridge Befehle/);
});

test("handle: unknown verb → handled:true with reply + paperclip_command error", async () => {
  const { bridge, fetchImpl } = makeBridge();
  const out = await bridge.handle("/paperclip frobnicate", { group: "Qwen" });
  assert.equal(out.handled, true);
  assert.match(out.reply, /Unbekannter Befehl/);
  assert.equal(out.error.code, "paperclip_command");
  assert.equal(fetchImpl.calls.length, 0);
});

test("handle: command syntax error → handled:true with reply + error", async () => {
  const { bridge } = makeBridge();
  const out = await bridge.handle("/paperclip status", { group: "Qwen" });
  assert.equal(out.handled, true);
  assert.match(out.reply, /Paperclip: /);
  assert.match(out.reply, /ISSUE/);
  assert.equal(out.error.code, "paperclip_command");
});

test("handle: Paperclip 401 surfaces as user-visible reply, not throw", async () => {
  const { bridge } = makeBridge({
    fetchScripts: [jsonResponse(401, { error: "bad key" })],
  });
  const out = await bridge.handle("/paperclip status INFA-11", { group: "Qwen" });
  assert.equal(out.handled, true);
  assert.match(out.reply, /Paperclip: Fehler/);
  assert.equal(out.error.code, "paperclip_auth");
});

test("isCommand: passes through", () => {
  const { bridge } = makeBridge();
  assert.equal(bridge.isCommand("/paperclip help"), true);
  assert.equal(bridge.isCommand("hello"), false);
});