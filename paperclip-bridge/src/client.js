// =============================================================================
// Paperclip API client.
//
// Thin fetch wrapper over Paperclip's REST API. Auth via `PAPERCLIP_API_KEY`.
// Base URL via `PAPERCLIP_API_URL`. No dependency on `node-fetch` — Node 18+
// ships `fetch`.
//
// Endpoints used:
//   GET    /api/agents/me
//   POST   /api/companies/{companyId}/issues       → createIssue
//   POST   /api/issues/{id}/comments               → comment / logEvent
//
// Module API (public):
//   await paperclip.logEvent({ kind, group, messageId, issueId? })
//   await paperclip.createIssue({ title, body, parentId? })
//   await paperclip.comment(issueId, body)
//   await paperclip.whoami()
//
// Idempotency: logEvent dedupes by (group, messageId, kind) for 60 s via an
// in-memory LRU. WhatsApp can re-deliver the same `message.id` and the bridge
// must not double-comment on the same issue.
//
// Rate-limiting: outbound requests are gated by a simple token bucket per
// (host, agent) so a runaway WhatsApp burst can't melt the API. Default 10
// requests/second with a burst of 20; tune via constructor options.
// =============================================================================

import {
  PaperclipAuthError,
  PaperclipTransientError,
  PaperclipProtocolError,
} from "./errors.js";

// --- config & defaults -------------------------------------------------------

function normalizeBase(url) {
  if (!url) throw new PaperclipProtocolError(
    "PAPERCLIP_API_URL is empty; cannot construct request URLs");
  return url.replace(/\/$/, "").replace(/\/api$/, "");
}

function requireKey(key) {
  if (!key || key.length === 0) {
    throw new PaperclipAuthError(
      "PAPERCLIP_API_KEY is missing or empty; refusing to send requests",
    );
  }
  return key;
}

// --- rate limiter (token bucket) ---------------------------------------------

class TokenBucket {
  constructor({ ratePerSecond, burst }) {
    this.rate = ratePerSecond;
    this.burst = burst;
    this.tokens = burst;
    this.lastRefill = Date.now();
  }
  async take(cost = 1) {
    while (true) {
      const now = Date.now();
      const elapsed = (now - this.lastRefill) / 1000;
      this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
      this.lastRefill = now;
      if (this.tokens >= cost) {
        this.tokens -= cost;
        return;
      }
      const waitMs = Math.ceil(((cost - this.tokens) / this.rate) * 1000);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

// --- LRU idempotency cache ---------------------------------------------------

class LruSet {
  constructor(max) {
    this.max = max;
    this.map = new Map();
  }
  has(key) { return this.map.has(key); }
  add(key) {
    if (this.map.has(key)) {
      this.map.delete(key); // touch — move to end
    }
    this.map.set(key, Date.now());
    if (this.map.size > this.max) {
      const first = this.map.keys().next().value;
      this.map.delete(first);
    }
  }
}

// --- client ------------------------------------------------------------------

/**
 * @typedef {object} ClientOptions
 * @property {string} apiKey       PAPERCLIP_API_KEY
 * @property {string} apiUrl       PAPERCLIP_API_URL (with or without trailing /api)
 * @property {string} [companyId]  Optional companyId; required for createIssue
 * @property {string} [agentId]    Optional agent id, sent as X-Paperclip-Agent-Id
 * @property {string} [runId]      Optional run id, sent as X-Paperclip-Run-Id
 * @property {number} [ratePerSecond]  Token-bucket refill (default 10)
 * @property {number} [burst]          Token-bucket burst (default 20)
 * @property {number} [idempotencyTtlMs]  Dedup TTL (default 60_000)
 * @property {number} [idempotencyMax]    LRU max keys (default 1000)
 * @property {number} [fetchTimeoutMs]  Per-request timeout (default 10_000)
 * @property {(input: Request) => Promise<Response>} [fetch]  Injected for tests
 */

export class PaperclipClient {
  /** @param {ClientOptions} opts */
  constructor(opts = {}) {
    const env = process.env ?? {};
    const apiKey = opts.apiKey !== undefined ? opts.apiKey : env.PAPERCLIP_API_KEY;
    const apiUrl = opts.apiUrl !== undefined ? opts.apiUrl : env.PAPERCLIP_API_URL;
    this.companyId = opts.companyId !== undefined
      ? opts.companyId : (env.PAPERCLIP_COMPANY_ID ?? null);
    this.agentId = opts.agentId !== undefined
      ? opts.agentId : (env.PAPERCLIP_AGENT_ID ?? null);
    this.runId = opts.runId !== undefined
      ? opts.runId : (env.PAPERCLIP_RUN_ID ?? null);
    this.baseUrl = normalizeBase(apiUrl ?? "");
    this.apiKey = requireKey(apiKey);
    this.bucket = new TokenBucket({
      ratePerSecond: opts.ratePerSecond ?? 10,
      burst: opts.burst ?? 20,
    });
    this.idempotency = new LruSet(opts.idempotencyMax ?? 1000);
    this.idempotencyTtlMs = opts.idempotencyTtlMs ?? 60_000;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? 10_000;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new PaperclipProtocolError(
        "no fetch implementation available; pass opts.fetch or run on Node >=18");
    }
  }

  // ---- transport --------------------------------------------------------------

  /**
   * Internal: do one HTTP request, parse JSON, map errors.
   * @param {string} method
   * @param {string} path  Begins with `/api/`
   * @param {object} [body]
   * @returns {Promise<any>}
   */
  async _request(method, path, body) {
    await this.bucket.take(1);
    const url = `${this.baseUrl}${path}`;
    const headers = {
      "Authorization": `Bearer ${this.apiKey}`,
      "Accept": "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.agentId) headers["X-Paperclip-Agent-Id"] = this.agentId;
    if (this.runId) headers["X-Paperclip-Run-Id"] = this.runId;

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("paperclip.fetch.timeout")),
      this.fetchTimeoutMs,
    );

    let res;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      throw new PaperclipTransientError(
        `network error contacting Paperclip: ${e?.message ?? e}`,
        { cause: String(e?.message ?? e) },
      );
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 401 || res.status === 403) {
      const text = await res.text().catch(() => "");
      throw new PaperclipAuthError(
        `Paperclip rejected credentials (HTTP ${res.status}): ${text.slice(0, 200)}`,
        { status: res.status, cause: text.slice(0, 200) },
      );
    }
    if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
      const text = await res.text().catch(() => "");
      throw new PaperclipTransientError(
        `Paperclip transient failure (HTTP ${res.status}): ${text.slice(0, 200)}`,
        { status: res.status, cause: text.slice(0, 200) },
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new PaperclipProtocolError(
        `Paperclip rejected request (HTTP ${res.status}): ${text.slice(0, 200)}`,
        { status: res.status, cause: text.slice(0, 200) },
      );
    }

    // Some endpoints may return empty body (204). Parse safely.
    if (res.status === 204) return null;
    const ct = res.headers?.get?.("content-type") ?? "";
    if (!ct.includes("application/json")) {
      // Non-JSON success — return text so callers can decide.
      return await res.text().catch(() => "");
    }
    try {
      return await res.json();
    } catch (e) {
      throw new PaperclipProtocolError(
        `Paperclip returned malformed JSON: ${e?.message ?? e}`,
        { status: res.status, cause: String(e?.message ?? e) },
      );
    }
  }

  // ---- public API -----------------------------------------------------------

  /** GET /api/agents/me — sanity check at boot. */
  whoami() {
    return this._request("GET", "/api/agents/me");
  }

  /**
   * POST /api/companies/{companyId}/issues
   * @param {{ title: string, body?: string, parentId?: string }} arg
   * @returns {Promise<{ id: string, identifier?: string, [k: string]: any }>}
   */
  async createIssue({ title, body, parentId }) {
    if (!this.companyId) {
      throw new PaperclipProtocolError(
        "createIssue requires companyId (set PAPERCLIP_COMPANY_ID or pass opts.companyId)");
    }
    if (!title || typeof title !== "string") {
      throw new PaperclipProtocolError("createIssue: title is required");
    }
    const payload = {
      title: title.trim(),
      description: body ?? "",
    };
    if (parentId) payload.parentId = parentId;
    const created = await this._request(
      "POST", `/api/companies/${this.companyId}/issues`, payload);
    if (!created || typeof created !== "object" || !created.id) {
      throw new PaperclipProtocolError(
        "createIssue: response did not include an id",
        { cause: JSON.stringify(created).slice(0, 200) });
    }
    return created;
  }

  /**
   * POST /api/issues/{id}/comments
   * @param {string} issueId
   * @param {string} body
   * @returns {Promise<object>}
   */
  async comment(issueId, body) {
    if (!issueId) throw new PaperclipProtocolError("comment: issueId required");
    if (typeof body !== "string") {
      throw new PaperclipProtocolError("comment: body must be a string");
    }
    return await this._request(
      "POST", `/api/issues/${issueId}/comments`, { body });
  }

  /**
   * Mirror a WhatsApp / lifecycle event onto a Paperclip issue.
   *
   * Default policy: only attach to EXISTING issues. If `issueId` is supplied,
   * the event is posted as a comment. If `issueId` is absent and the event
   * qualifies for issue creation (rare, opt-in), the caller must supply
   * `createNew: true` + `newTitle` to opt in.
   *
   * Idempotency: dedupes by (group, messageId, kind) for `idempotencyTtlMs`.
   * Returns `{ status: "commented" | "duplicate" | "skipped" }`.
   *
   * @param {{
   *   kind: "whatsapp.message" | "message.received" | "message.replied"
   *       | "poll.created" | "error" | "lifecycle.startup"
   *       | "lifecycle.error" | "group.registration",
   *   group?: string,
   *   messageId?: string,
   *   issueId?: string,
   *   body?: string,
   *   createNew?: boolean,
   *   newTitle?: string,
   * }} ev
   */
  async logEvent(ev) {
    if (!ev || typeof ev.kind !== "string") {
      throw new PaperclipProtocolError("logEvent: ev.kind is required");
    }

    const key = `${ev.kind}|${ev.group ?? ""}|${ev.messageId ?? ""}|${ev.issueId ?? ""}`;
    const now = Date.now();
    if (this.idempotency.has(key)) {
      const age = now - (this.idempotency.map.get(key) ?? now);
      if (age < this.idempotencyTtlMs) {
        return { status: "duplicate", dedupKey: key };
      }
    }

    const body = ev.body ?? renderEventBody(ev);

    if (!ev.issueId) {
      if (ev.createNew && ev.newTitle) {
        const created = await this.createIssue({
          title: ev.newTitle,
          body,
        });
        this.idempotency.add(key);
        return { status: "created", issueId: created.id };
      }
      this.idempotency.add(key); // remember we saw it, even if we dropped it
      return { status: "skipped", reason: "no_issue_id" };
    }

    const posted = await this.comment(ev.issueId, body);
    this.idempotency.add(key);
    return { status: "commented", issueId: ev.issueId, comment: posted };
  }
}

// --- body renderer for outbound events ---------------------------------------

/**
 * Render a structured WhatsApp/lifecycle event as a Markdown comment body.
 * Keep this stable: it's the contract Integrator / Tech Lead sees on the
 * issue thread and in the demo report.
 *
 * @param {object} ev
 * @returns {string}
 */
export function renderEventBody(ev) {
  const ts = new Date().toISOString();
  switch (ev.kind) {
    case "whatsapp.message":
    case "message.received":
      return [
        `### message.received — ${ts}`,
        ev.group ? `- **group**: \`${ev.group}\`` : null,
        ev.messageId ? `- **messageId**: \`${ev.messageId}\`` : null,
        ev.preview ? `- **preview**: ${ev.preview.slice(0, 240)}` : null,
        ev.adapterId ? `- **adapter**: \`${ev.adapterId}\`` : null,
      ].filter(Boolean).join("\n");
    case "message.replied":
      return [
        `### message.replied — ${ts}`,
        ev.group ? `- **group**: \`${ev.group}\`` : null,
        ev.messageId ? `- **messageId**: \`${ev.messageId}\`` : null,
        ev.adapterId ? `- **adapter**: \`${ev.adapterId}\`` : null,
        ev.latencyMs != null ? `- **latencyMs**: ${ev.latencyMs}` : null,
        ev.voice ? `- **voice**: true` : null,
      ].filter(Boolean).join("\n");
    case "poll.created":
      return [
        `### poll.created — ${ts}`,
        ev.group ? `- **group**: \`${ev.group}\`` : null,
        ev.pollId ? `- **pollId**: \`${ev.pollId}\`` : null,
        ev.header ? `- **header**: ${ev.header}` : null,
        Array.isArray(ev.options)
          ? `- **options** (${ev.options.length}): ${ev.options.join(", ")}`
          : null,
      ].filter(Boolean).join("\n");
    case "error":
    case "lifecycle.error":
      return [
        `### error — ${ts}`,
        ev.group ? `- **group**: \`${ev.group}\`` : null,
        ev.messageId ? `- **messageId**: \`${ev.messageId}\`` : null,
        ev.message ? `- **message**: ${ev.message}` : null,
        ev.stack ? `<details><summary>stack</summary>\n\n\`\`\`\n${ev.stack}\n\`\`\`\n</details>` : null,
      ].filter(Boolean).join("\n");
    case "lifecycle.startup":
      return [
        `### lifecycle.startup — ${ts}`,
        ev.version ? `- **version**: \`${ev.version}\`` : null,
        ev.groups?.length ? `- **groups**: ${ev.groups.join(", ")}` : null,
      ].filter(Boolean).join("\n");
    case "group.registration":
      return [
        `### group.registration — ${ts}`,
        ev.group ? `- **group**: \`${ev.group}\`` : null,
        ev.action ? `- **action**: ${ev.action}` : null,
        ev.jid ? `- **jid**: \`${ev.jid}\`` : null,
      ].filter(Boolean).join("\n");
    default:
      return [
        `### ${ev.kind} — ${ts}`,
        ev.group ? `- **group**: \`${ev.group}\`` : null,
        ev.messageId ? `- **messageId**: \`${ev.messageId}\`` : null,
      ].filter(Boolean).join("\n");
  }
}

/** Convenience factory. */
export function createClient(opts = {}) {
  return new PaperclipClient(opts);
}