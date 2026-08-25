// =============================================================================
// Infinity WhatsApp client — entrypoint.
//
// Wires together: config -> adapter -> media store -> dispatcher.
// The Endpoints Integrator module is NOT imported here directly; the wiring
// is injected via `INFINITY_INTEGRATOR_ADAPTERS`, which the Integrator / Tech
// Lead registers at deploy time. That keeps the project buildable without
// the sibling Integrator workspace on disk.
// =============================================================================

import { loadConfig } from "./config.js";
import { Dispatcher, type AdapterFactory } from "./dispatcher.js";
import { Logger } from "./logger.js";
import { MediaStore } from "./media.js";
import { WWebJsAdapter } from "./wwebjsAdapter.js";

// Wire the Endpoints Integrator adapter factory into globalThis. Requiring
// `endpoints-integrator/register.js` is a side-effect that installs the real
// factory so the dispatcher never falls back to the `[stub:…]` placeholder.
// If the package can't be resolved we want a loud failure at boot, not a
// silent stub loop — every group would echo back `[stub:…]` text instead of
// real answers, which is exactly what INFA-18 set out to fix.
// `register.js` is plain CommonJS without a `.d.ts`; the type information
// lives on `globalThis.INFINITY_INTEGRATOR_ADAPTERS`, which `dispatcher.ts`
// already exports as `AdapterFactory`.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../endpoints-integrator/register.js");

declare global {
  // Set by the Endpoints Integrator's `register.js` at boot:
  //   globalThis.INFINITY_INTEGRATOR_ADAPTERS = (name) => new …Adapter();
  // eslint-disable-next-line no-var
  var INFINITY_INTEGRATOR_ADAPTERS: AdapterFactory | undefined;
}

async function main(): Promise<void> {
  const { groups, runtime } = loadConfig();
  const log = new Logger("main", runtime.logLevel);

  // Fail loudly if the Integrator factory never installed itself. Without
  // this guard, the dispatcher silently falls back to the stub factory and
  // groups receive `[stub:qwenCode] …` text instead of real answers.
  if (!globalThis.INFINITY_INTEGRATOR_ADAPTERS) {
    throw new Error(
      "End-to-end wiring is incomplete: globalThis.INFINITY_INTEGRATOR_ADAPTERS " +
        "is unset after requiring 'endpoints-integrator/register.js'. " +
        "Check that the Endpoints Integrator workspace is present and its " +
        "register.js exports the factory.",
    );
  }

  const media = new MediaStore(runtime.mediaDir, log);
  await media.init();

  const adapter = new WWebJsAdapter(groups, runtime, media);

  adapter.onEvent((ev) => {
    switch (ev.kind) {
      case "ready":
        log.info("lifecycle.ready");
        break;
      case "auth":
        log.info("lifecycle.pairing");
        break;
      case "reconnecting":
        log.warn("lifecycle.reconnecting", { reason: ev.reason });
        break;
      case "disconnected":
        log.warn("lifecycle.disconnected", { reason: ev.reason });
        break;
      case "error":
        log.error("lifecycle.error", { message: ev.error.message });
        break;
    }
  });

  const factory: AdapterFactory = globalThis.INFINITY_INTEGRATOR_ADAPTERS!;

  const dispatcher = new Dispatcher(adapter, factory, log);
  dispatcher.bind();

  await adapter.start();

  // Graceful shutdown so SIGTERM doesn't leave the chromium child running.
  const shutdown = async (signal: string) => {
    log.info("shutdown.received", { signal });
    await adapter.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: "error",
    component: "main",
    msg: "fatal",
    error: err instanceof Error ? err.message : String(err),
  }));
  process.exit(1);
});
