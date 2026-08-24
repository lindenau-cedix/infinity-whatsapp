// Smoke tests for the trigger parser — runnable with `node --test` (Node 18+).
//
// We avoid a heavier runner so the WhatsApp client stays npm-installable
// with no test-only deps. The dispatcher integration tests live in the
// Integrator / Tech Lead's workspace.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { parseTriggers } from "../src/triggers";

test("plain text passes through untouched", () => {
  const r = parseTriggers("hello world");
  assert.equal(r.text, "hello world");
  assert.equal(r.voiceReply, false);
  assert.equal(r.grillMe, false);
});

test("voice prefix is stripped and flagged", () => {
  const r = parseTriggers("Antworte sprachlich: was ist TCP?");
  assert.equal(r.text, ": was ist TCP?");
  assert.equal(r.voiceReply, true);
  assert.equal(r.grillMe, false);
});

test("grill prefix is stripped and flagged", () => {
  const r = parseTriggers("Grill Me: Plane eine Hochzeit");
  assert.equal(r.text, "Plane eine Hochzeit");
  assert.equal(r.voiceReply, false);
  assert.equal(r.grillMe, true);
});

test("voice prefix wins when both are present", () => {
  const r = parseTriggers("Antworte sprachlich Grill Me: foo");
  assert.equal(r.voiceReply, true);
  assert.equal(r.grillMe, true);
});

test("prefixes are case-insensitive", () => {
  const r = parseTriggers("antworte sprachlich: hi");
  assert.equal(r.voiceReply, true);
  assert.equal(r.text, ": hi");
});
