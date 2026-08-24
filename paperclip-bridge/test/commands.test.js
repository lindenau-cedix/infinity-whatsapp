// =============================================================================
// Slash-command grammar tests.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseCommand,
  isPaperclipCommand,
  HELP_TEXT,
} from "../src/commands.js";
import { PaperclipCommandError } from "../src/errors.js";

// --- detection -------------------------------------------------------------

test("isPaperclipCommand: /paperclip prefix", () => {
  assert.equal(isPaperclipCommand("/paperclip status INFA-11"), true);
});

test("isPaperclipCommand: paperclip: prefix (no slash)", () => {
  assert.equal(isPaperclipCommand("paperclip: status INFA-11"), true);
});

test("isPaperclipCommand: @paperclip prefix", () => {
  assert.equal(isPaperclipCommand("@paperclip help"), true);
});

test("isPaperclipCommand: leading whitespace tolerated", () => {
  assert.equal(isPaperclipCommand("   /paperclip help"), true);
});

test("isPaperclipCommand: case-insensitive", () => {
  assert.equal(isPaperclipCommand("/Paperclip HELP"), true);
  assert.equal(isPaperclipCommand("/PAPERCLIP status INFA-11"), true);
});

test("isPaperclipCommand: unrelated messages return false", () => {
  assert.equal(isPaperclipCommand("hello world"), false);
  assert.equal(isPaperclipCommand(""), false);
  assert.equal(isPaperclipCommand(null), false);
});

// --- parsing ---------------------------------------------------------------

test("parseCommand: status", () => {
  const c = parseCommand("/paperclip status INFA-11");
  assert.equal(c.verb, "status");
  assert.equal(c.issueRef, "INFA-11");
});

test("parseCommand: status with uuid", () => {
  const c = parseCommand("/paperclip status 00467aa7-d71d-4cb3-9704-73a28ce4f4c0");
  assert.equal(c.verb, "status");
  assert.equal(c.issueRef, "00467aa7-d71d-4cb3-9704-73a28ce4f4c0");
});

test("parseCommand: comment joins remaining tokens into body", () => {
  const c = parseCommand("/paperclip comment INFA-11 please investigate bridge");
  assert.equal(c.verb, "comment");
  assert.equal(c.issueRef, "INFA-11");
  assert.equal(c.body, "please investigate bridge");
});

test("parseCommand: new collects title across tokens", () => {
  const c = parseCommand("paperclip: new Investigate webhook dedupe");
  assert.equal(c.verb, "new");
  assert.equal(c.title, "Investigate webhook dedupe");
});

test("parseCommand: help", () => {
  const c = parseCommand("/paperclip help");
  assert.equal(c.verb, "help");
});

test("parseCommand: unknown verb throws PaperclipCommandError", () => {
  assert.throws(
    () => parseCommand("/paperclip frobnicate"),
    (e) => {
      assert.ok(e instanceof PaperclipCommandError);
      assert.match(e.message, /Unbekannter Befehl/);
      return true;
    },
  );
});

test("parseCommand: status without ref throws", () => {
  assert.throws(
    () => parseCommand("/paperclip status"),
    (e) => e instanceof PaperclipCommandError,
  );
});

test("parseCommand: comment without body throws", () => {
  assert.throws(
    () => parseCommand("/paperclip comment INFA-11"),
    (e) => e instanceof PaperclipCommandError,
  );
});

test("parseCommand: empty new throws", () => {
  assert.throws(
    () => parseCommand("/paperclip new"),
    (e) => e instanceof PaperclipCommandError,
  );
});

test("HELP_TEXT: mentions the three verbs the demo uses", () => {
  assert.match(HELP_TEXT, /status/);
  assert.match(HELP_TEXT, /comment/);
  assert.match(HELP_TEXT, /new/);
  assert.match(HELP_TEXT, /paperclip/i);
});