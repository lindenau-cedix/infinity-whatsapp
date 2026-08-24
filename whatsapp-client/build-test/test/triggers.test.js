"use strict";
// Smoke tests for the trigger parser — runnable with `node --test` (Node 18+).
//
// We avoid a heavier runner so the WhatsApp client stays npm-installable
// with no test-only deps. The dispatcher integration tests live in the
// Integrator / Tech Lead's workspace.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const assert = __importStar(require("node:assert/strict"));
const triggers_1 = require("../src/triggers");
(0, node_test_1.test)("plain text passes through untouched", () => {
    const r = (0, triggers_1.parseTriggers)("hello world");
    assert.equal(r.text, "hello world");
    assert.equal(r.voiceReply, false);
    assert.equal(r.grillMe, false);
});
(0, node_test_1.test)("voice prefix is stripped and flagged", () => {
    const r = (0, triggers_1.parseTriggers)("Antworte sprachlich: was ist TCP?");
    assert.equal(r.text, ": was ist TCP?");
    assert.equal(r.voiceReply, true);
    assert.equal(r.grillMe, false);
});
(0, node_test_1.test)("grill prefix is stripped and flagged", () => {
    const r = (0, triggers_1.parseTriggers)("Grill Me: Plane eine Hochzeit");
    assert.equal(r.text, "Plane eine Hochzeit");
    assert.equal(r.voiceReply, false);
    assert.equal(r.grillMe, true);
});
(0, node_test_1.test)("voice prefix wins when both are present", () => {
    const r = (0, triggers_1.parseTriggers)("Antworte sprachlich Grill Me: foo");
    assert.equal(r.voiceReply, true);
    assert.equal(r.grillMe, true);
});
(0, node_test_1.test)("prefixes are case-insensitive", () => {
    const r = (0, triggers_1.parseTriggers)("antworte sprachlich: hi");
    assert.equal(r.voiceReply, true);
    assert.equal(r.text, ": hi");
});
