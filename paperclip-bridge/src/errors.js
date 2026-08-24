// =============================================================================
// Errors for the Paperclip bridge.
//
// Surfaced with a stable `code` so the message pipeline (owned by the
// Integrator / Tech Lead) can branch on `error.code` rather than parsing
// messages. We never throw raw `fetch` errors at the caller — those are
// wrapped into one of these three codes.
// =============================================================================

export class PaperclipError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {object} [opts]
   * @param {number} [opts.status]
   * @param {string} [opts.cause]
   */
  constructor(code, message, opts = {}) {
    super(message);
    this.name = "PaperclipError";
    this.code = code;
    if (typeof opts.status === "number") this.status = opts.status;
    if (opts.cause) this.cause = opts.cause;
  }
}

/**
 * 401 / 403 — the configured PAPERCLIP_API_KEY is missing or rejected.
 * Caller should NOT silently retry. Treat like the adapter AuthError pattern.
 */
export class PaperclipAuthError extends PaperclipError {
  constructor(message, opts = {}) {
    super("paperclip_auth", message, opts);
    this.name = "PaperclipAuthError";
  }
}

/**
 * 429 / 5xx — temporary upstream failure. Safe to retry with backoff.
 */
export class PaperclipTransientError extends PaperclipError {
  constructor(message, opts = {}) {
    super("paperclip_transient", message, opts);
    this.name = "PaperclipTransientError";
  }
}

/**
 * 4xx other than 401/403/429, plus malformed JSON / unexpected shape.
 */
export class PaperclipProtocolError extends PaperclipError {
  constructor(message, opts = {}) {
    super("paperclip_protocol", message, opts);
    this.name = "PaperclipProtocolError";
  }
}

/**
 * Local error: bad input from the WhatsApp side, e.g. unknown slash command.
 * The bridge surfaces this as a user-visible reply (NOT a Paperclip event).
 */
export class PaperclipCommandError extends PaperclipError {
  constructor(message, opts = {}) {
    super("paperclip_command", message, opts);
    this.name = "PaperclipCommandError";
  }
}