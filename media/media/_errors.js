// =============================================================================
// Error type for the Voice & Media module.
//
// Plain Error subclass + a short `code` field so the WhatsApp Client Engineer
// can branch on it (e.g. `e.code === "unsupported_mime"` → reply "I can't
// read that file type"). Message is already user-meaningful.
// =============================================================================

export class MediaError extends Error {
  /**
   * @param {"unsupported_mime"|"too_large"|"download_failed"|"transcribe_failed"|"missing_payload"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "MediaError";
    this.code = code;
  }
}
