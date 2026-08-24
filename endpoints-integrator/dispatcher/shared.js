// =============================================================================
// dispatcher/shared.js
//
// Small helpers used by every dispatcher module:
//   - envKey(name): read an env var or throw an AuthError with a clear hint
//   - runWithRetry(fn, opts): wrap an async call with timeout + exponential backoff
//   - trimForReply(text, maxChars): bound outbound text length for WhatsApp
//
// The contract surfaced by every adapter is `run(prompt, ctx) → Promise<string>`.
// All HTTP / CLI work flows through runWithRetry so timeouts and retries live in
// exactly one place — adapters stay small and obvious.
// =============================================================================

'use strict';

class AuthError extends Error {
  constructor(key, adapter, hint) {
    const msg =
      `AuthError: missing credential "${key}"\n` +
      `  → required by adapter "${adapter}"\n` +
      `  → ${hint}`;
    super(msg);
    this.name = 'AuthError';
    this.key = key;
    this.adapter = adapter;
  }
}

class DispatcherError extends Error {
  constructor(adapter, message, cause) {
    super(`[${adapter}] ${message}${cause ? `: ${cause.message || cause}` : ''}`);
    this.name = 'DispatcherError';
    this.adapter = adapter;
    this.cause = cause;
  }
}

function envKey(name, { adapter, hint }) {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new AuthError(name, adapter, hint);
  }
  return v;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run an async fn with timeout + retry-with-backoff.
 *
 * opts:
 *   attempts        total tries (default 3)
 *   baseDelayMs     first backoff sleep (default 250)
 *   timeoutMs       per-attempt hard cap (default 20_000)
 *   retryOn         array of status codes / error names that trigger retry
 *                   (default: network errors + 429 + 5xx)
 */
async function runWithRetry(fn, opts = {}) {
  const {
    attempts = 3,
    baseDelayMs = 250,
    timeoutMs = 20_000,
    retryOn,
    adapter = 'unknown',
  } = opts;

  const shouldRetry = (err, status) => {
    if (err instanceof AuthError) return false; // never retry on bad creds
    // 401/403 from upstream = bad creds. Never retry — rotating the key is
    // the only fix, and hammering the provider just gets us rate-limited.
    if (status === 401 || status === 403) return false;
    if (retryOn) {
      return retryOn.some((r) => (typeof r === 'number' ? r === status : err?.name === r));
    }
    if (status === 429) return true;
    if (status && status >= 500 && status < 600) return true;
    if (err && (err.name === 'AbortError' || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET')) {
      return true;
    }
    return false;
  };

  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fn({ signal: controller.signal });
    } catch (err) {
      lastErr = err;
      const status = err?.status;
      const retriable = shouldRetry(err, status);
      clearTimeout(timer);
      if (!retriable || attempt === attempts) break;
      // exponential backoff: base * 2^(attempt-1), with a tiny jitter
      const jitter = Math.floor(Math.random() * 80);
      const wait = baseDelayMs * 2 ** (attempt - 1) + jitter;
      await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new DispatcherError(adapter, 'all retries exhausted', lastErr);
}

function trimForReply(text, maxChars = 3500) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n\n[…truncated…]';
}

module.exports = {
  AuthError,
  DispatcherError,
  envKey,
  runWithRetry,
  sleep,
  trimForReply,
};