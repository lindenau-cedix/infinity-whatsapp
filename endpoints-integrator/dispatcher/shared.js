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
 *                   (default: network errors + 429 + 5xx + undici `fetch failed`
 *                   wrappers whose .cause has no useful diagnostic)
 *
 * Transport-failure handling (INFA-24):
 *   undici wraps fetch-time failures as `TypeError('fetch failed')` (or, in
 *   undici 22+, sometimes as a plain `Error('fetch failed')`) with the real
 *   cause on `.cause`. The first iteration treated only code-bearing causes
 *   as retriable; the second iteration (this one) also retries when the
 *   wrapper itself is a `fetch failed` even with a null/opaque `.cause`, so
 *   a single TLS race or proxy drop no longer kills the whole call.
 */
// Network error codes (Node 18+ undici surfaces these on the `fetch failed`
// TypeError's `.cause.code`). Treat any of them as retriable — they're all
// transient transport failures, never an auth or contract problem.
const RETRIABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ENETUNREACH',
  'ECONNREFUSED',
  'EPIPE',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Walk an error's cause chain looking for the first entry with a useful
 * diagnostic: a `.code` (ECONNRESET/EAI_AGAIN/...) or a `.name` that's
 * neither the generic `Error`/`TypeError` nor a `fetch failed` wrapper.
 *
 * Node 18+ undici wraps low-level transport failures in
 * `TypeError: fetch failed` (sometimes `Error: fetch failed` in undici 22+)
 * with the real cause buried under `.cause`. In some TLS / proxy / keep-
 * alive races the cause itself is `null` or a plain Error with no `.code`,
 * and in those cases the wrapper message IS the only diagnostic. Without
 * this helper the operator sees "fetch failed" with no signal why.
 *
 * We honour `code` first (most informative), then `name` (skips the generic
 * wrappers, accepts anything informative), and fall back to the wrapper
 * itself so its `.message` is still available downstream.
 */
function unwrapCause(err) {
  let cur = err;
  for (let i = 0; cur && i < 5; i++) {
    if (cur.code) return cur;
    if (cur.name && cur.name !== 'Error' && cur.name !== 'TypeError' && cur.name !== 'FetchError') return cur;
    cur = cur.cause;
  }
  return err;
}

/**
 * Recognise undici's transport-failure wrapper as retriable even when the
 * cause chain yields no useful code/name. undici surfaces fetch-time failures
 * as `TypeError('fetch failed')` or, in undici 22+, sometimes as a plain
 * `Error('fetch failed')`. We match by message (not by class) so wrapped
 * copies (e.g. across module boundaries) still match.
 */
function isFetchFailedWrapper(err) {
  return Boolean(
    err &&
    typeof err.message === 'string' &&
    err.message.trim() === 'fetch failed' &&
    (err.name === 'TypeError' || err.name === 'Error' || err.name === 'FetchError' || err.name === undefined)
  );
}

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
    // Unwrap undici's `fetch failed` wrapper so we see the real code/name.
    const inner = unwrapCause(err) || err;
    if (inner.name === 'AbortError') return true;
    if (inner.code && RETRIABLE_NETWORK_CODES.has(inner.code)) return true;
    // INFA-24 follow-up: undici surfaces transport failures (TLS races,
    // proxy drops, body-parser aborts, undici-22+ plain-Error wrapper) as
    // a `fetch failed` wrapper whose `.cause` may be null or carry no
    // `.code`. Treat the wrapper itself as a retriable transport failure
    // — the alternative is giving up on a perfectly transient blip.
    if (isFetchFailedWrapper(err) || isFetchFailedWrapper(inner)) return true;
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
  // Surface the underlying cause chain so operators don't see a bare
  // "fetch failed" when the real error is ECONNRESET / EAI_AGAIN / a
  // TLS-race AbortError / an undici socket drop. The envelope prefers
  // (code > name > cause-message) so even opaque wrappers like undici-22+
  // `Error('fetch failed')` with no .cause at least tell the operator
  // "fetch failed (cause: <message>)" instead of a bare "fetch failed".
  const inner = unwrapCause(lastErr) || lastErr;
  const innerTag = inner?.code
    || (inner?.name && inner.name !== 'Error' && inner.name !== 'TypeError' && inner.name !== 'FetchError' ? inner.name : null);
  let detail;
  if (innerTag) {
    detail = `${lastErr?.message || 'fetch failed'} (${innerTag})`;
  } else if (lastErr?.cause && typeof lastErr.cause.message === 'string' && lastErr.cause.message.trim() !== 'fetch failed') {
    detail = `${lastErr.message || 'fetch failed'} (cause: ${lastErr.cause.message})`;
  } else {
    detail = lastErr?.message || 'fetch failed';
  }
  throw new DispatcherError(adapter, 'all retries exhausted', Object.assign(new Error(detail), {
    cause: lastErr,
    code: inner?.code,
    name: inner?.name || lastErr?.name,
    status: lastErr?.status,
  }));
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