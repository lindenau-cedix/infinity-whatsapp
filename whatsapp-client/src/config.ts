// =============================================================================
// Config — single source of truth for the four group JIDs and runtime knobs.
// Loaded once at boot from process.env. Anything group-related flows through
// here; nothing else in the codebase reads group IDs ad hoc.
// =============================================================================

import * as path from "node:path";

/**
 * The four endpoints Infinity delegates to, and the canonical group label
 * that the upstream Integrator / Tech Lead uses in logging and in the
 * `PromptContext.group` field. Keep this enum aligned with
 * `EndpointAdapter.name` values from the Endpoints Integrator workspace.
 */
export type EndpointName =
  | "qwenCode"
  | "perplexityReasoning"
  | "perplexityDeepResearch"
  | "firecrawl";

export interface GroupConfig {
  /** WhatsApp JID (e.g. `120363...@g.us` for groups, `…@c.us` for contacts). */
  jid: string;
  /** Human label used in logs and in `PromptContext.group`. */
  label: string;
  /** Which endpoint dispatches prompts from this group. */
  endpoint: EndpointName;
}

export interface RuntimeConfig {
  /** Path on disk where whatsapp-web.js persists the LocalAuth bundle. */
  sessionPath: string;
  /** Headless chromium for whatsapp-web.js. */
  headless: boolean;
  /** Where downloaded attachments land. */
  mediaDir: string;
  /** Log verbosity. */
  logLevel: "silent" | "error" | "warn" | "info" | "debug";
}

/**
 * Loads config from env. Throws on startup if any group JID is missing —
 * a half-configured Infinity is worse than no Infinity.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): {
  groups: Record<EndpointName, GroupConfig>;
  runtime: RuntimeConfig;
} {
  const jidQwen = required("WA_GROUP_JID_QWEN", env);
  const jidPerpRp = required("WA_GROUP_JID_PERP_RP", env);
  const jidPerpDr = required("WA_GROUP_JID_PERP_DR", env);
  const jidFirecrawl = required("WA_GROUP_JID_FIRECRAWL", env);

  const groups: Record<EndpointName, GroupConfig> = {
    qwenCode: {
      jid: jidQwen,
      label: "Qwen",
      endpoint: "qwenCode",
    },
    perplexityReasoning: {
      jid: jidPerpRp,
      label: "Perp. RP",
      endpoint: "perplexityReasoning",
    },
    perplexityDeepResearch: {
      jid: jidPerpDr,
      label: "Perp. DR",
      endpoint: "perplexityDeepResearch",
    },
    firecrawl: {
      jid: jidFirecrawl,
      label: "Firecrawl",
      endpoint: "firecrawl",
    },
  };

  const runtime: RuntimeConfig = {
    sessionPath: path.resolve(env.WA_SESSION_PATH ?? "./.wa-session"),
    headless: (env.WA_HEADLESS ?? "true").toLowerCase() !== "false",
    mediaDir: path.resolve(env.INFINITY_MEDIA_DIR ?? "./media"),
    logLevel: (env.LOG_LEVEL ?? "info") as RuntimeConfig["logLevel"],
  };

  return { groups, runtime };
}

/**
 * Reverse lookup: given an inbound message's chat JID, find the routing
 * config. Returns undefined if the chat is not one of the four configured
 * groups — in which case the dispatcher must ignore the message.
 */
export function findGroupByJid(
  jid: string,
  groups: Record<EndpointName, GroupConfig>,
): GroupConfig | undefined {
  for (const cfg of Object.values(groups)) {
    if (cfg.jid === jid) return cfg;
  }
  return undefined;
}

function required(name: string, env: NodeJS.ProcessEnv): string {
  const v = env[name];
  if (!v || v.trim() === "") {
    throw new ConfigError(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v.trim();
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
