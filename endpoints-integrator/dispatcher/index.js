// =============================================================================
// dispatcher/index.js
//
// Single entry point consumed by the WhatsApp client. Exposes:
//
//   dispatch(endpointKey, prompt, ctx)  → Promise<string>
//
// endpointKey ∈ {"qwen", "perplexity-reasoning-pro", "perplexity-deep-research", "firecrawl"}
//
// `ctx` is opaque to the dispatcher; we just forward what each adapter needs:
//   { requestId, group, mediaPaths, ...endpointSpecific (qwenBin, qwenModel,
//     model, apiKey, baseUrl) }
//
// Prompt-format conventions (handled by the WhatsApp client BEFORE dispatch):
//
//   - "Grill Me: <topic>"   → strip the prefix; the Grill-Me Skill Engineer
//     decides how to fan out questions. Dispatcher only sees the cleaned
//     prompt.
//
//   - "Antworte sprachlich: <…>" → strip the prefix, mark `voice: true` on
//     the outbound reply envelope. Dispatcher still returns plain text; the
//     Voice & Media Engineer converts it to ElevenLabs audio downstream.
//
//   - Media: ctx.mediaPaths is an array of absolute filesystem paths the
//     media handler saved (images, video, audio). Adapters do NOT read the
//     files — they receive path references and only the Qwen adapter
//     currently supports multimodel input (others are text-only). If an
//     adapter wants to embed media, it should pass `<media:/abs/path>`
//     tokens to the model so it can read them server-side. Base64 injection
//     is explicitly disallowed.
// =============================================================================

'use strict';

const qwen = require('./qwen.js');
const perplexity = require('./perplexity.js');
const firecrawl = require('./firecrawl.js');
const { probeEndpoint } = require('./shared.js');

const VALID_KEYS = new Set([
  'qwen',
  'perplexity-reasoning-pro',
  'perplexity-deep-research',
  'firecrawl',
]);

/**
 * INFA-24 deeper: at boot, probe each cloud provider's base URL so a
 * disconnected host fails fast in the logs instead of waiting until the
 * first user request. The probe is unauthenticated (cheap, no API-key
 * leak) and only logs warnings — runtime traffic is unaffected.
 *
 * Disable with `INFINITY_SKIP_BOOT_PROBE=1` when running unit tests that
 * stub fetch.
 */
async function probeAtBoot() {
  if (process.env.INFINITY_SKIP_BOOT_PROBE === '1') return;
  const baseUrl = process.env.PERPLEXITY_BASE_URL || 'https://api.perplexity.ai';
  const result = await probeEndpoint(baseUrl);
  if (!result.reachable) {
    // eslint-disable-next-line no-console
    console.warn(
      `[integrator] WARNING: Perplexity endpoint ${baseUrl} unreachable at boot — ` +
      `first live call will likely fail. cause: ${result.cause || result.error}`,
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(`[integrator] Perplexity endpoint reachable (HTTP ${result.status})`);
  }
}

/**
 * Dispatch a prompt to the right adapter.
 *
 * @param {"qwen"|"perplexity-reasoning-pro"|"perplexity-deep-research"|"firecrawl"} endpointKey
 * @param {string} prompt
 * @param {object} ctx  see module header for shape
 * @returns {Promise<string>}  reply text to send back to WhatsApp
 */
async function dispatch(endpointKey, prompt, ctx = {}) {
  if (!VALID_KEYS.has(endpointKey)) {
    throw new Error(
      `dispatch: unknown endpointKey "${endpointKey}". ` +
        `Valid keys: ${[...VALID_KEYS].join(', ')}`,
    );
  }
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new Error('dispatch: prompt must be a non-empty string');
  }

  switch (endpointKey) {
    case 'qwen':
      return qwen.run(prompt, ctx);
    case 'perplexity-reasoning-pro':
      return perplexity.run(prompt, { ...ctx, model: 'sonar-reasoning-pro' });
    case 'perplexity-deep-research':
      return perplexity.run(prompt, { ...ctx, model: 'sonar-deep-research' });
    case 'firecrawl':
      return firecrawl.run(prompt, ctx);
    default:
      // Unreachable thanks to VALID_KEYS check, but keeps the linter honest.
      throw new Error(`dispatch: unreachable endpointKey ${endpointKey}`);
  }
}

/**
 * List all endpoint keys. Useful for the WhatsApp client's /healthz endpoint.
 */
function listEndpoints() {
  return [...VALID_KEYS];
}

module.exports = { dispatch, listEndpoints, probeAtBoot };

// Fire-and-forget — the boot probe is best-effort and must not block module
// load. Errors are swallowed and logged; callers don't await it.
if (
  process.env.INFINITY_SKIP_BOOT_PROBE !== '1' &&
  process.env.NODE_ENV !== 'test'
) {
  probeAtBoot().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(`[integrator] boot probe crashed (non-fatal): ${err?.message || err}`);
  });
}