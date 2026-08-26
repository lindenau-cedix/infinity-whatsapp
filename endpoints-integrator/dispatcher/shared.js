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

/**
 * Return true when the error chain is a `fetch failed` wrapper whose cause
 * carries zero diagnostic information — no .code, no informative .name, and
 * either no .cause at all or a .cause whose .message is also 'fetch failed'
 * (or missing).
 *
 * INFA-24 follow-up (deeper): when EVERY retry produces this shape, the host
 * almost certainly can't reach the endpoint at all (firewall, proxy drop,
 * IPv6-only target with broken v4 fallback, etc.). Retrying the full
 * attempts budget just burns the operator's 20-minute SLA window. Bail out
 * fast and surface an actionable hint instead.
 */
function isFullyOpaqueFetchFailure(err) {
  if (!isFetchFailedWrapper(err)) return false;
  const inner = unwrapCause(err) || err;
  if (inner && inner !== err) {
    if (inner.code) return false;          // we DO have a code somewhere
    if (inner.name && inner.name !== 'Error' && inner.name !== 'TypeError' && inner.name !== 'FetchError') return false;
    if (inner.message && inner.message.trim() !== '' && inner.message.trim() !== 'fetch failed') return false;
  }
  // Wrapper itself + opaque cause (or no cause) + no code/name/message → bare.
  return true;
}

/**
 * Actionable hint surfaced when we give up on a fully-opaque fetch failure.
 * Tells the operator what to check first on the host — most of the time the
 * endpoint is simply unreachable from where the daemon is running.
 */
const HOST_CONNECTIVITY_HINT =
  'Perplexity endpoint unreachable from this host. Check: ' +
  '(1) outbound HTTPS to api.perplexity.ai is allowed by firewall/proxy; ' +
  '(2) DNS resolves (e.g. `getent hosts api.perplexity.ai` returns an IP); ' +
  '(3) no corporate TLS-inspection proxy is rewriting the cert chain; ' +
  '(4) Node version is 18+ (uses undici fetch).';

async function runWithRetry(fn, opts = {}) {
  const {
    attempts = 3,
    baseDelayMs = 250,
    timeoutMs = 20_000,
    retryOn,
    adapter = 'unknown',
    /**
     * INFA-24 deeper: when every failure is a fully-opaque `fetch failed`
     * wrapper (no .code, no informative .name, no informative .cause
     * message), the host almost certainly can't reach the endpoint at all.
     * Retrying the full attempts budget wastes the operator's SLA window.
     * After `opaqueBailAfter` consecutive fully-opaque failures (default 2),
     * give up early and surface a host-connectivity hint instead. Set to
     * Infinity to disable.
     */
    opaqueBailAfter = 2,
  } = opts;

  let consecutiveOpaque = 0;

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
      // Track the "fully opaque" run separately. If we keep getting bare
      // fetch-failed wrappers with no diagnostic, the host almost certainly
      // can't reach the endpoint at all — burn the SLA window by retrying
      // for the full attempts budget would just leave the operator waiting
      // 20 minutes for the same opaque message.
      if (isFullyOpaqueFetchFailure(err)) {
        consecutiveOpaque += 1;
      } else {
        consecutiveOpaque = 0;
      }
      clearTimeout(timer);
      if (!retriable || attempt === attempts) break;
      // INFA-24 deeper: bail out early when we've accumulated
      // `opaqueBailAfter` consecutive fully-opaque failures with no signal
      // that anything is changing. The host is almost certainly offline to
      // this endpoint; the operator needs a clear hint, not another 18
      // minutes of identical errors.
      if (consecutiveOpaque >= opaqueBailAfter) break;
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
  // INFA-24 deeper: when the cause chain was fully opaque across the whole
  // retry budget, the failure is almost certainly a host-connectivity issue
  // rather than a transient blip. Surface the connectivity hint inline so
  // the operator doesn't have to guess what's wrong.
  let envelopeMessage = 'all retries exhausted';
  if (consecutiveOpaque >= opaqueBailAfter && isFullyOpaqueFetchFailure(lastErr)) {
    envelopeMessage = `all retries exhausted (early bail: ${consecutiveOpaque} consecutive opaque fetch failures) — ${HOST_CONNECTIVITY_HINT}`;
  }
  throw new DispatcherError(adapter, envelopeMessage, Object.assign(new Error(detail), {
    cause: lastErr,
    code: inner?.code,
    name: inner?.name || lastErr?.name,
    status: lastErr?.status,
  }));
}

/**
 * Boot-time reachability probe for a provider's base URL.
 *
 * INFA-24 deeper: a host that can't reach the provider should be flagged at
 * boot, not after the first user request burns 20 minutes on Perplexity
 * deep-research. This is intentionally cheap: short timeout, GET (most
 * providers accept GET on the root with a 401/405 response), and we DO NOT
 * leak the API key (the probe is unauthenticated on purpose).
 *
 * Returns { reachable: boolean, status?: number, error?: string }. Never
 * throws — callers log the result and proceed.
 *
 * @param {string} baseUrl  e.g. https://api.perplexity.ai
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=5000]  per-attempt timeout
 * @param {number} [opts.attempts=2]      total tries (1 + 1 retry)
 */
async function probeEndpoint(baseUrl, opts = {}) {
  const { timeoutMs = 5_000, attempts = 2 } = opts;
  const url = `${(baseUrl || '').replace(/\/$/, '')}/`;
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: 'GET', signal: controller.signal });
      clearTimeout(timer);
      // Any HTTP response (including 401/405/404) means the host CAN reach
      // the endpoint. Only a network-level failure counts as unreachable.
      return { reachable: true, status: res.status };
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (i < attempts) await sleep(250);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    reachable: false,
    error: lastErr?.message || 'unknown error',
    cause: lastErr?.cause?.message,
  };
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
  probeEndpoint,
  isFetchFailedWrapper,
  isFullyOpaqueFetchFailure,
  unwrapCause,
  HOST_CONNECTIVITY_HINT,
};