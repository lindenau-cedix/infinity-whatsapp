// =============================================================================
// register.js
//
// Glue layer between the WhatsApp client (workspace `d1a31c3e-…`) and the
// Integrator's `dispatcher/` folder (workspace `06a1c280-…`).
//
// The WhatsApp client expects a global `AdapterFactory`:
//
//   globalThis.INFINITY_INTEGRATOR_ADAPTERS =
//     (name: "qwenCode" | "perplexityReasoning" | "perplexityDeepResearch" | "firecrawl")
//       => { name, run(prompt, ctx) -> Promise<{ text, mediaRefs, usage? }> }
//
// where `ctx` is the WhatsApp-side `IntegratorContext`:
//   { requestId: string, group: string, mediaPaths: string[] }
//
// The Integrator's `dispatcher/index.js` exposes a slightly different surface:
//
//   dispatch(endpointKey, prompt, ctx) -> Promise<string>
//
// with endpoint keys "qwen" | "perplexity-reasoning-pro" |
// "perplexity-deep-research" | "firecrawl", and where each adapter lives
// behind `dispatcher/{qwen,perplexity,firecrawl}.js` and reads its own
// credentials from `process.env` via `envKey(...)` (synchronous auth at call
// time). The CLI qwen adapter ignores `ctx.mediaPaths` (CLI is text-only).
//
// This module is a thin adapter factory: it maps the WhatsApp endpoint name
// to the Integrator dispatch key, wraps each `dispatch(...)` call so the
// returned string is wrapped into a `Reply`, and provides a top-level helper
// (`registerIntegratorAdapters()`) plus a side-effecting default `require()`
// that installs the factory onto `globalThis.INFINITY_INTEGRATOR_ADAPTERS`.
//
// The Integrator ships two parallel implementations in this workspace:
//   - `src/index.ts` — typed `EndpointAdapter`/`Reply`/`PromptContext` per
//     `src/types.ts`. Not yet built (no `tsc` step in `package.json`).
//   - `dispatcher/*.js` — CommonJS, runnable directly under `node --test`.
// We wire to the JS one (no build step needed to unblock INFA-6) and keep the
// wrapper shape compatible with what the TypeScript barrel would emit once
// the project ships a build pipeline.
// =============================================================================

'use strict';

const { dispatch } = require('./dispatcher/index.js');

/**
 * Maps the WhatsApp-side endpoint name (camelCase, declared in
 * `dispatcher.ts` AdapterFactory union) to the Integrator dispatch key.
 * @type {Record<string, string>}
 */
const NAME_TO_DISPATCH_KEY = Object.freeze({
  qwenCode: 'qwen',
  perplexityReasoning: 'perplexity-reasoning-pro',
  perplexityDeepResearch: 'perplexity-deep-research',
  firecrawl: 'firecrawl',
});

/** The complete set of names the factory accepts. */
const SUPPORTED_NAMES = Object.freeze(Object.keys(NAME_TO_DISPATCH_KEY));

class InvalidEndpointError extends Error {
  constructor(name) {
    super(
      `INFINITY_INTEGRATOR_ADAPTERS: unknown endpoint "${name}". ` +
        `Valid names: ${SUPPORTED_NAMES.join(', ')}`,
    );
    this.name = 'InvalidEndpointError';
    this.endpoint = name;
  }
}

/**
 * Wrap a string-returning dispatch() into the IntegratorAdapter shape the
 * WhatsApp dispatcher consumes. The WhatsApp side passes through `ctx` as-is
 * — for the JS dispatcher that means requestId is forwarded (it already is
 * via `dispatch()`), group is forwarded (the dispatcher ignores it, only
 * used for logging), and mediaPaths is forwarded (all current JS adapters
 * ignore it; only the future TypeScript Qwen adapter will consume it).
 */
function wrap(name) {
  const dispatchKey = NAME_TO_DISPATCH_KEY[name];
  if (!dispatchKey) throw new InvalidEndpointError(name);

  return Object.freeze({
    name,
    async run(prompt, ctx = {}) {
      const startedAt = Date.now();
      const text = await dispatch(dispatchKey, prompt, ctx);
      return {
        text,
        mediaRefs: [], // text-only by contract; Firecrawl returns markdown inline
        usage: { latencyMs: Date.now() - startedAt },
      };
    },
  });
}

/**
 * The AdapterFactory the WhatsApp client expects. Module singleton so
 * `require('./register.js')` returns the same function every time and the
 * side-effect below stays idempotent.
 */
function adapterFactory(name) {
  return wrap(name);
}

/**
 * Install the factory on `globalThis` if it isn't already there. Returns
 * the installed factory so the caller can keep a reference too.
 */
function registerIntegratorAdapters(target = globalThis) {
  if (!target.INFINITY_INTEGRATOR_ADAPTERS) {
    target.INFINITY_INTEGRATOR_ADAPTERS = adapterFactory;
  }
  return target.INFINITY_INTEGRATOR_ADAPTERS;
}

// --- side-effect: install on require() so a plain `require('./register.js')`
// in the WhatsApp client entrypoint is enough to wire everything up. The
// WhatsApp client already falls back to a stub when this global is absent,
// so the assignment here is what swaps the stub for the live factory.
registerIntegratorAdapters(globalThis);

module.exports = {
  adapterFactory,
  registerIntegratorAdapters,
  // Re-exported for unit tests / smoke scripts.
  NAME_TO_DISPATCH_KEY,
  SUPPORTED_NAMES,
  InvalidEndpointError,
};
