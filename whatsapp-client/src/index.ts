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

declare global {
  // Set by the Integrator / Tech Lead at deploy time:
  //   globalThis.INFINITY_INTEGRATOR_ADAPTERS = (name) => new …Adapter();
  // eslint-disable-next-line no-var
  var INFINITY_INTEGRATOR_ADAPTERS: AdapterFactory | undefined;
}

async function main(): Promise<void> {
  const { groups, runtime } = loadConfig();
  const log = new Logger("main", runtime.logLevel);

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

  const factory: AdapterFactory =
    globalThis.INFINITY_INTEGRATOR_ADAPTERS ??
    ((name) => {
      // No Integrator module registered — return a stub that logs the request
      // and surfaces the dispatch shape so the WhatsApp side can be tested
      // end-to-end before the Integrator is wired in.
      log.warn("integrator.stub", { endpoint: name });
      return {
        name,
        async run(prompt: string) {
          return {
            text: `[stub:${name}] received: ${prompt.slice(0, 80)}`,
            mediaRefs: [],
          };
        },
      };
    });

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
