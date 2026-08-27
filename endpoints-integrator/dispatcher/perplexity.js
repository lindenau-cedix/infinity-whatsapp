// =============================================================================
// dispatcher/perplexity.js
//
// One dispatcher file covers BOTH Perplexity models (sonar-reasoning-pro and
// sonar-deep-research). Per INFA-7's spec, the `model` argument picks which
// one is called. Both hit the same chat-completions endpoint.
//
//   POST https://api.perplexity.ai/chat/completions
//   Authorization: Bearer <PERPLEXITY_API_KEY>
//
// Quirks:
//   - Reasoning models return an extra `choices[0].message.reasoning` field
//     (chain-of-thought). We deliberately do NOT surface that — only
//     `content` flows back to WhatsApp.
//   - Deep-research can run 30s–5min. We still hit the synchronous endpoint
//     because Perplexity returns the full report in one response when the
//     model name is `sonar-deep-research`; no async polling required.
//   - sonar-reasoning-pro is gated on some accounts. If 404, surface the
//     upstream error so Tech Lead can investigate model naming.
// =============================================================================

'use strict';

const { envKey, runWithRetry, trimForReply, getLongRequestDispatcher } = require('./shared.js');

const DEFAULT_BASE_URL = 'https://api.perplexity.ai';
const DEFAULT_MODELS = {
  'sonar-reasoning-pro': 'sonar-reasoning-pro',
  'sonar-deep-research': 'sonar-deep-research',
};

function pickModel(model) {
  if (!model) {
    throw new Error('perplexity: model is required (use "sonar-reasoning-pro" or "sonar-deep-research")');
  }
  // Allow callers to pass either the explicit key or an env override.
  const env = process.env[`PERPLEXITY_${model.replace(/[^A-Z0-9]/gi, '_').toUpperCase()}_MODEL`];
  if (env) return env;
  if (DEFAULT_MODELS[model]) return DEFAULT_MODELS[model];
  return model; // trust caller-provided custom model names
}

/**
 * Make a Perplexity chat completions call.
 * Exposed so the smoke test and dispatcher/index.js can both use it.
 *
 * @param {object} args
 * @param {string} args.apiKey
 * @param {string} args.model
 * @param {string} args.prompt
 * @param {string} [args.requestId]
 * @param {string} [args.baseUrl]
 * @param {object} [args.signal]  AbortSignal for timeouts
 */
async function callPerplexity({ apiKey, model, prompt, requestId, baseUrl, signal, timeoutMs }) {
  const url = `${(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')}/chat/completions`;
  // INFA-24 root cause: undici caps headersTimeout/bodyTimeout at 300s by
  // default. sonar-deep-research emits NOTHING until the report is finished
  // (measured live: 121s and 185s for trivial prompts), so a real query sits
  // right on that cliff and undici kills the socket — surfacing as a bare
  // `TypeError: fetch failed`. Hand long calls a dispatcher with those timers
  // disabled so the AbortController below is the only deadline in play.
  // Undefined for short calls, or when `undici` isn't resolvable.
  const dispatcher = getLongRequestDispatcher(timeoutMs);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(requestId ? { 'X-Request-Id': requestId } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal,
    ...(dispatcher ? { dispatcher } : {}),
  });

  if (res.status === 401 || res.status === 403) {
    const e = new Error(`provider rejected key (HTTP ${res.status}). Rotate at https://www.perplexity.ai/settings/api`);
    e.status = res.status;
    throw e;
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const e = new Error(`HTTP ${res.status} ${res.statusText} — ${errText.slice(0, 200)}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

/**
 * @param {string} prompt
 * @param {object} ctx  { requestId, group, mediaPaths, model: "sonar-reasoning-pro" | "sonar-deep-research", baseUrl?, apiKey? }
 * @returns {Promise<string>}
 */
async function run(prompt, ctx = {}) {
  if (typeof prompt !== 'string') {
    throw new TypeError('perplexity: prompt must be a string');
  }
  if (!ctx.model) {
    throw new Error('perplexity: ctx.model is required (e.g. "sonar-reasoning-pro")');
  }
  // Resolve API key from ctx first, then the canonical shared var, then the
  // per-model overrides documented in endpoints-integrator/.env.example
  // (PERPLEXITY_REASONING_API_KEY / PERPLEXITY_DEEP_RESEARCH_API_KEY). The
  // per-model keys are how operators actually set secrets today, so we MUST
  // honour them — otherwise every group except Qwen falls through to the
  // missing-credential stub and looks silently broken (INFA-20).
  const perModelEnv =
    ctx.model === 'sonar-deep-research'
      ? 'PERPLEXITY_DEEP_RESEARCH_API_KEY'
      : 'PERPLEXITY_REASONING_API_KEY';
  const resolveApiKey = () =>
    ctx.apiKey ||
    process.env.PERPLEXITY_API_KEY ||
    process.env[perModelEnv];

  // Stub fallback (INFA-20): if no API key is configured, return a friendly
  // visible reply instead of throwing AuthError. Qwen works without env
  // keys; Perplexity + Firecrawl need explicit credentials, and a silent
  // empty reply from these groups makes the system look broken. Surfacing
  // the missing-credential hint here gives the operator immediate feedback
  // without changing the contract for live calls (a real key still flows
  // through to callPerplexity() below).
  if (!resolveApiKey()) {
    return stubMissingCredential(ctx.model);
  }
  const apiKey = resolveApiKey();
  const model = pickModel(ctx.model);
  const baseUrl = ctx.baseUrl || process.env.PERPLEXITY_BASE_URL || DEFAULT_BASE_URL;
  const requestId = ctx.requestId || `perp-${Date.now()}`;

  // Deep research runs longer — Perplexity's docs say 30s–5min per call.
  // INFA-24: deep-research needs a deadline ABOVE undici's 300s default, not
  // equal to it. The old value was exactly 300_000 — the same number undici
  // uses for headersTimeout — so the two timers raced and undici usually won,
  // producing an opaque `fetch failed`. We now disable undici's internal
  // timers (see getLongRequestDispatcher) and own the deadline here.
  // Measured live: trivial deep-research prompts take 121s–185s, and
  // Perplexity documents up to 5min, so 300s left no headroom at all.
  // 600s x 3 attempts keeps the worst case near the old ~20min ceiling.
  const isDeepResearch = ctx.model === 'sonar-deep-research';
  const timeoutMs = isDeepResearch ? 600_000 : 90_000;
  const attempts = isDeepResearch ? 3 : 3;

  const json = await runWithRetry(
    ({ signal }) => callPerplexity({ apiKey, model, prompt, requestId, baseUrl, signal, timeoutMs }),
    {
      adapter: `perplexity/${ctx.model}`,
      attempts,
      baseDelayMs: 500,
      timeoutMs,
      // Verify before blaming the network: if the endpoint answers this
      // probe, the envelope reports a slow request instead of falsely
      // telling the operator the host can't reach Perplexity (INFA-24).
      probeBaseUrl: baseUrl,
    },
  );

  const raw = json?.choices?.[0]?.message?.content;
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) {
    throw new Error('perplexity: empty content in response');
  }
  return trimForReply(text);
}

/**
 * Visible stub reply used when no PERPLEXITY_API_KEY is configured. Echoes
 * the prompt back so the operator can confirm the routing works (group →
 * endpoint) and surfaces the missing-key hint inline. INFA-20 contract:
 * never leave a configured group silent.
 */
function stubMissingCredential(model) {
  const friendly = model === 'sonar-deep-research'
    ? 'Perplexity Deep Research'
    : 'Perplexity Sonar Reasoning Pro';
  const perModelEnv = model === 'sonar-deep-research'
    ? 'PERPLEXITY_DEEP_RESEARCH_API_KEY'
    : 'PERPLEXITY_REASONING_API_KEY';
  return (
    `🔧 *${friendly}* (Stub)\n\n` +
    `Dieser Endpoint ist verdrahtet, aber es fehlt der API-Key.\n\n` +
    `So aktivierst du ihn:\n` +
    `  1. Key holen: https://www.perplexity.ai/settings/api\n` +
    `  2. Setzen (eine Variante genügt):\n` +
    `     \`export PERPLEXITY_API_KEY=…\`\n` +
    `     \`export ${perModelEnv}=…\`\n` +
    `  3. WhatsApp-Client neu starten.\n\n` +
    `Bis dahin bekommst du diesen Stub statt einer echten Antwort.`
  );
}

module.exports = { run, callPerplexity, DEFAULT_BASE_URL, DEFAULT_MODELS, stubMissingCredential };