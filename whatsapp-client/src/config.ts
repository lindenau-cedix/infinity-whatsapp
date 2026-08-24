// =============================================================================
// Config — single source of truth for the four group JIDs and runtime knobs.
// Loaded once at boot from process.env, with a fallback .env reader so an
// operator who fills .env and runs `npm start` doesn't have to know about
// dotenv, source, or `set -a`. Anything group-related flows through here;
// nothing else in the codebase reads group IDs ad hoc.
// =============================================================================

import * as fs from "node:fs";
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
 *
 * If the process env doesn't already define a key we need, fall back to a
 * one-shot read of `.env` in the cwd (or any parent directory up to the
 * workspace root). Existing process env always wins, so systemd / docker
 * / `set -a; source .env` overrides still take precedence — the .env read
 * only fills gaps, never clobbers.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): {
  groups: Record<EndpointName, GroupConfig>;
  runtime: RuntimeConfig;
} {
  ensureDotEnvLoaded(env);

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
      `Missing required env var ${name}. ` +
        `Copy .env.example to .env, fill it in, and run from the project root — ` +
        `or export ${name}=<jid> in your shell before starting the daemon.`,
    );
  }
  return v.trim();
}

/**
 * One-shot `.env` reader. Walks up from cwd looking for `.env`, parses KEY=VALUE
 * lines, and only sets keys that are unset in `env`. Idempotent and side-effect
 * free on `process.env`: the optional `target` parameter exists for tests; in
 * production we always write into the passed-in env so loadConfig() can be
 * driven by a custom env object without polluting the real process env twice.
 *
 * We hand-roll this to avoid pulling in dotenv. Lines starting with `#` are
 * comments; `export FOO=…` and inline `# comments` after a value are stripped.
 * Quoted values are unquoted. No variable expansion, no multi-line values —
 * matching what we already write in `.env.example`.
 */
const DOTENV_LOADED = { done: false, foundPath: null as string | null };

export function ensureDotEnvLoaded(env: NodeJS.ProcessEnv): void {
  if (DOTENV_LOADED.done) {
    if (DOTENV_LOADED.foundPath) applyDotEnv(DOTENV_LOADED.foundPath, env);
    return;
  }
  DOTENV_LOADED.done = true;
  const filePath = findDotEnv(process.cwd());
  DOTENV_LOADED.foundPath = filePath;
  if (filePath) applyDotEnv(filePath, env);
}

function findDotEnv(start: string): string | null {
  let dir = path.resolve(start);
  // Bound the search so we never walk past the filesystem root.
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function applyDotEnv(filePath: string, env: NodeJS.ProcessEnv): void {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const stripped = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trim()
      : trimmed;
    const eq = stripped.indexOf("=");
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = stripped.slice(eq + 1).trim();
    // Strip optional inline comment.
    const hashIdx = value.indexOf(" #");
    if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
    // Strip surrounding quotes.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    // Process env wins; never clobber.
    if (env[key] === undefined || env[key] === "") {
      env[key] = value;
    }
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
