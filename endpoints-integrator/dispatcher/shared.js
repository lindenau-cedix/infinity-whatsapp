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
 * INFA-24 widening: some upstream failures (notably Perplexity sonar-deep-
 * research moderation refusals) surface as `TypeError("fetch failed")` with
 * the HTTP status and body buried on `.cause.{status,body}`. Before this
 * widening the cause walk skipped past those (no .code, .name was generic)
 * and the dispatcher classified the whole envelope as a transparent
 * transport failure — operators saw "all retries exhausted: fetch failed"
 * with no hint that the request had been refused by the moderation
 * endpoint. The walk now also accepts a `.status` as a useful diagnostic so
 * a HTTP 4xx refusal is surfaced clearly.
 *
 * We honour `code` first (most informative), then `status` (catches
 * 4xx/5xx buried in the cause chain — see INFA-24 widening), then `name`
 * (skips the generic wrappers, accepts anything informative), and fall back
 * to the wrapper itself so its `.message` is still available downstream.
 */
function unwrapCause(err) {
  let cur = err;
  for (let i = 0; cur && i < 5; i++) {
    if (cur.code) return cur;
    // HTTP status on the cause: undici sometimes attaches `.status` (and
    // `.body`) to the cause when an upstream response is read partially.
    // 4xx in particular is the smoking gun for a per-query refusal (e.g.
    // Perplexity moderation) wrapped in a `fetch failed` envelope. We
    // surface it like a code so the retry classifier and the error
    // envelope can both see it.
    if (typeof cur.status === 'number' && cur.status >= 100 && cur.status < 600) return cur;
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
 *
 * INFA-24 widening: a `.status` on the cause (or on the wrapper itself)
 * counts as a diagnostic. Without this carve-out, an upstream 4xx moderation
 * refusal wrapped in `TypeError("fetch failed")` was being classified as
 * fully opaque, the operator saw the connectivity-hint envelope, and the
 * real reason (the upstream rejected the query) was buried in the cause's
 * `.message`. With the carve-out the cause walk has somewhere to land and
 * `isFullyOpaqueFetchFailure` correctly returns false.
 */
function isFullyOpaqueFetchFailure(err) {
  if (!isFetchFailedWrapper(err)) return false;
  const inner = unwrapCause(err) || err;
  if (inner && inner !== err) {
    if (inner.code) return false;          // we DO have a code somewhere
    // INFA-24 widening: a .status on the unwrapped chain is a diagnostic.
    if (typeof inner.status === 'number' && inner.status >= 100 && inner.status < 600) return false;
    if (inner.name && inner.name !== 'Error' && inner.name !== 'TypeError' && inner.name !== 'FetchError') return false;
    if (inner.message && inner.message.trim() !== '' && inner.message.trim() !== 'fetch failed') return false;
  }
  // Wrapper itself + opaque cause (or no cause) + no code/status/name/message → bare.
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
     *
     * INFA-24 widens this: persistent *visible* transport-cluster failures
     * (UND_ERR_SOCKET, UND_ERR_CONNECT_TIMEOUT, ECONNRESET-class codes, ...)
     * are also a connectivity problem, not a transient blip. After
     * `opaqueBailAfter` consecutive failures of either flavor we bail
     * with the same host-connectivity hint.
     */
    opaqueBailAfter = 2,
  } = opts;

  // Counts consecutive failures that smell like host-connectivity trouble,
  // either because they are fully-opaque (no diagnostic at all) OR because
  // they carry a visible transport-cluster code/name. Either flavor
  // triggers the early-bail + hint envelope after `opaqueBailAfter` hits.
  let consecutiveUnreachable = 0;

  const shouldRetry = (err, status) => {
    if (err instanceof AuthError) return false; // never retry on bad creds
    // INFA-24 widening: when the cause chain carries an HTTP status
    // (e.g. undici surfaces a Perplexity moderation 422 as
    // `TypeError("fetch failed")` with the status on `.cause`), the
    // `status` argument may not see it. Unwrap here so a 4xx buried in the
    // cause chain still short-circuits to non-retriable below.
    const innerForStatus = unwrapCause(err) || err;
    const effectiveStatus = status ?? innerForStatus?.status;
    // 401/403 from upstream = bad creds. Never retry — rotating the key is
    // the only fix, and hammering the provider just gets us rate-limited.
    if (effectiveStatus === 401 || effectiveStatus === 403) return false;
    // INFA-24 widening: 4xx (except 408 / 429) is a per-request refusal
    // (moderation block, validation error, unsupported model, ...). It is
    // NEVER a transport blip — retrying just hits the same refusal and
    // burns the operator's SLA window. The envelope should surface the real
    // status + body so the caller knows the upstream rejected the query.
    if (
      effectiveStatus && effectiveStatus >= 400 && effectiveStatus < 500 &&
      effectiveStatus !== 408 && effectiveStatus !== 429
    ) return false;
    // 408 (Request Timeout) is technically retriable, and 429 (Rate
    // Limited) is the canonical "back off and try again" code. Handle them
    // via the explicit status branches below.
    if (retryOn) {
      return retryOn.some((r) => (typeof r === 'number' ? r === effectiveStatus : err?.name === r));
    }
    if (effectiveStatus === 408 || effectiveStatus === 429) return true;
    if (effectiveStatus && effectiveStatus >= 500 && effectiveStatus < 600) return true;
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
      // Track the "unreachable cluster" run. Either fully-opaque wrappers
      // (no diagnostic at all) OR visible transport-cluster failures
      // (UND_ERR_SOCKET, ECONNRESET-class codes, ...) signal host-side
      // connectivity trouble. Burning the full SLA window on either flavor
      // just leaves the operator waiting for the same message.
      if (isFullyOpaqueFetchFailure(err) || isTransportClusterError(err)) {
        consecutiveUnreachable += 1;
      } else {
        consecutiveUnreachable = 0;
      }
      clearTimeout(timer);
      if (!retriable || attempt === attempts) break;
      // INFA-24 deeper / INFA-24 wider: bail out early when we've
      // accumulated `opaqueBailAfter` consecutive unreachable-cluster
      // failures with no signal that anything is changing. The host is
      // almost certainly offline to this endpoint; the operator needs a
      // clear hint, not another 18 minutes of identical errors.
      if (consecutiveUnreachable >= opaqueBailAfter) break;
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
  // (code > status > name > cause-message) so even opaque wrappers like
  // undici-22+ `Error('fetch failed')` with no .cause at least tell the
  // operator "fetch failed (cause: <message>)" instead of a bare
  // "fetch failed".
  //
  // INFA-24 widening: when the cause chain carries an HTTP status (e.g.
  // undici surfaces a Perplexity moderation 422 as `TypeError("fetch
  // failed")` with the status buried on `.cause`), prefer that as the tag
  // — "fetch failed (HTTP 422)" is dramatically more actionable than
  // "fetch failed (cause: ...)". We append a short body excerpt when
  // present so the operator can see WHY the upstream refused without
  // having to dig through logs.
  const inner = unwrapCause(lastErr) || lastErr;
  const innerCode = inner?.code;
  const innerStatus = typeof inner?.status === 'number' ? inner.status : null;
  const innerName = inner?.name && inner.name !== 'Error' && inner.name !== 'TypeError' && inner.name !== 'FetchError' ? inner.name : null;
  let detail;
  if (innerCode) {
    detail = `${lastErr?.message || 'fetch failed'} (${innerCode})`;
  } else if (innerStatus) {
    const bodyExcerpt = typeof inner?.body === 'string' && inner.body.trim() !== ''
      ? ` — ${inner.body.trim().slice(0, 200)}`
      : '';
    detail = `${lastErr?.message || 'fetch failed'} (HTTP ${innerStatus})${bodyExcerpt}`;
  } else if (innerName) {
    detail = `${lastErr?.message || 'fetch failed'} (${innerName})`;
  } else if (lastErr?.cause && typeof lastErr.cause.message === 'string' && lastErr.cause.message.trim() !== 'fetch failed') {
    detail = `${lastErr.message || 'fetch failed'} (cause: ${lastErr.cause.message})`;
  } else {
    detail = lastErr?.message || 'fetch failed';
  }
  // INFA-24 deeper: when the cause chain was fully opaque across the whole
  // retry budget, the failure is almost certainly a host-connectivity issue
  // rather than a transient blip. Surface the connectivity hint inline so
  // the operator doesn't have to guess what's wrong.
  //
  // INFA-24 wider: a persistent *visible* transport-cluster error
  // (UND_ERR_SOCKET / UND_ERR_CONNECT_TIMEOUT / ECONNRESET-class code / ...)
  // has the same root cause — host can't reach this endpoint. The envelope
  // gives the operator the same hint rather than a bare
  // `fetch failed (UND_ERR_SOCKET)` they have no actionable response to.
  let envelopeMessage = 'all retries exhausted';
  const terminalUnreachable =
    consecutiveUnreachable >= opaqueBailAfter &&
    (isFullyOpaqueFetchFailure(lastErr) || isTransportClusterError(lastErr));
  if (terminalUnreachable) {
    envelopeMessage =
      `all retries exhausted (early bail: ${consecutiveUnreachable} consecutive ` +
      `unreachable-host failures) — ${HOST_CONNECTIVITY_HINT}`;
  }
  throw new DispatcherError(adapter, envelopeMessage, Object.assign(new Error(detail), {
    cause: lastErr,
    code: inner?.code,
    name: inner?.name || lastErr?.name,
    status: lastErr?.status,
  }));
}

// Names undici uses to wrap transport-layer socket / connect failures on the
// `.cause.name` (or sometimes on the wrapper itself in older undici). Together
// with RETRIABLE_NETWORK_CODES these are the "host almost certainly can't
// reach this endpoint" error classes — when they cluster, treating the cluster
// the same way we treat fully-opaque failures (early bail + connectivity
// hint) saves the operator minutes of identical error traffic.
const TRANSPORT_FATAL_NAMES = new Set([
  'SocketError',
  'ConnectTimeoutError',
  'RequestAbortedError',
  'ClientError',
  'HeadersTimeoutError',
  'BodyTimeoutError',
  'ResponseExceededMaxSizeError',
]);

/**
 * Return true when an unwrapped error chain looks like a host-side transport
 * failure on a code-or-name basis — either it carries one of the canonical
 * network codes (ECONNRESET, UND_ERR_SOCKET, ...), or its `.name` is one
 * of the known undici transport-error classes. Fully-opaque wrappers with
 * no signal anywhere are caught separately by `isFullyOpaqueFetchFailure`;
 * this helper picks up the *visible-signal* cluster where the operator
 * already sees `fetch failed (UND_ERR_SOCKET)` but the code insists the
 * error isn't yet "obviously unreachable". Two consecutive hits of either
 * flavor deserve the same treatment.
 */
function isTransportClusterError(err) {
  if (!err) return false;
  const inner = unwrapCause(err) || err;
  if (inner?.code && RETRIABLE_NETWORK_CODES.has(inner.code)) return true;
  if (inner?.name && TRANSPORT_FATAL_NAMES.has(inner.name)) return true;
  // undici surfaces UND_ERR_* via `.name` on the inner error in some
  // versions and via `.code` on the `.cause` in others. Cover both.
  if (typeof inner?.name === 'string' && inner.name.startsWith('UND_ERR_')) return true;
  return false;
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
  isTransportClusterError,
  unwrapCause,
  HOST_CONNECTIVITY_HINT,
};