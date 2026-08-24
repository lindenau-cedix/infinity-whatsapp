"use strict";
// =============================================================================
// Trigger detection. Strips the two known prefixes and surfaces them as
// boolean flags on the IngressMessage. Order matters — "Antworte sprachlich"
// wins over "Grill Me:" when both appear, because that's how the dispatcher's
// downstream handlers compose (Grill-Me produces clarifying questions,
// voice reply turns the eventual *answer* into audio).
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseTriggers = parseTriggers;
const VOICE_PREFIX = "Antworte sprachlich";
const GRILL_PREFIX = "Grill Me:";
function parseTriggers(raw) {
    let body = raw;
    let voiceReply = false;
    let grillMe = false;
    // Trim leading whitespace first; prefixes are matched against the cleaned
    // beginning of the body.
    const trimmed = body.replace(/^\s+/, "");
    if (caseInsensitiveStartsWith(trimmed, VOICE_PREFIX)) {
        voiceReply = true;
        body = trimmed.slice(VOICE_PREFIX.length);
    }
    if (caseInsensitiveStartsWith(body.trimStart(), GRILL_PREFIX)) {
        grillMe = true;
        // Slice after re-trimming so we don't double-count the whitespace we just
        // removed. Keep the rest of the body intact.
        body = body.trimStart().slice(GRILL_PREFIX.length);
    }
    return { text: body.trim(), voiceReply, grillMe };
}
function caseInsensitiveStartsWith(s, prefix) {
    return s.toLowerCase().startsWith(prefix.toLowerCase());
}
