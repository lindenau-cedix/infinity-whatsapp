// =============================================================================
// Credential vault loader.
//
// Reads .env once at boot, validates required keys, and exposes a typed
// Credentials object. Adapters receive ctx.credentials — they never read
// process.env directly. On a missing key, raise AuthError with the key name
// and which adapter demanded it; never silently retry.
//
// INFA-17: `QWEN_API_KEY` was removed when the Qwen dispatcher became
// local-CLI only (dispatcher/qwen.js uses `qwen -m qwen3:30b-a3b -p`).
// There is no cloud credential for Qwen anymore. The `qwen` slot on
// `Credentials` is preserved as a vestigial shape so legacy callers
// don't crash; `apiKey` is always "" and `baseUrl` is informational.
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

// --- public types -----------------------------------------------------------

export type KeyName =
  | "PERPLEXITY_REASONING_API_KEY"
  | "PERPLEXITY_DEEP_RESEARCH_API_KEY"
  | "FIRECRAWL_API_KEY"
  | "OPENAI_WHISPER_API_KEY"
  | "ELEVENLABS_API_KEY"
  | "ELEVENLABS_VOICE_ID";

export interface Credentials {
  qwen: { apiKey: string; baseUrl: string };
  perplexityReasoning: { apiKey: string; model: string };
  perplexityDeepResearch: { apiKey: string; model: string };
  firecrawl: { apiKey: string; baseUrl: string };
  // Voice & Media Engineer reads these directly; we only presence-check.
  media: { openaiWhisperApiKey: string; elevenLabsApiKey: string; elevenLabsVoiceId: string };
  mediaDir: string;
}

// --- errors -----------------------------------------------------------------

export class AuthError extends Error {
  constructor(
    public readonly key: KeyName,
    public readonly adapter: string,
    hint: string,
  ) {
    super(
      `AuthError: missing credential "${key}"\n` +
        `  → required by adapter "${adapter}"\n` +
        `  → ${hint}`,
    );
    this.name = "AuthError";
  }
}

// --- loader -----------------------------------------------------------------

const DEFAULTS: Record<string, string> = {
  // Qwen defaults live in dispatcher/qwen.js (QWEN_BIN / QWEN_MODEL).
  // INTENTIONALLY EMPTY HERE — there is no QWEN_BASE_URL after INFA-17.
  PERPLEXITY_REASONING_MODEL: "sonar-reasoning-pro",
  PERPLEXITY_DEEP_RESEARCH_MODEL: "sonar-deep-research",
  FIRECRAWL_BASE_URL: "https://api.firecrawl.dev",
  ELEVENLABS_VOICE_ID: "",
  INFINITY_MEDIA_DIR: "./media",
};

function parseDotenv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function readDotenv(envPath: string): Record<string, string> {
  if (!fs.existsSync(envPath)) return {};
  return parseDotenv(fs.readFileSync(envPath, "utf8"));
}

function readKey(file: Record<string, string>, name: KeyName): string | undefined {
  const fromFile = file[name];
  if (fromFile && fromFile.length > 0) return fromFile;
  const fromProc = process.env[name];
  if (fromProc && fromProc.length > 0) return fromProc;
  return undefined;
}

function requireKey(
  file: Record<string, string>,
  name: KeyName,
  adapter: string,
  hint: string,
): string {
  const v = readKey(file, name);
  if (!v) throw new AuthError(name, adapter, hint);
  return v;
}

function lookup<T extends string>(
  file: Record<string, string>,
  name: string,
): T {
  const v = file[name] ?? process.env[name];
  return (v && v.length > 0 ? v : DEFAULTS[name]) as T;
}

/**
 * Load and validate the credential vault.
 *
 * @param envPath absolute path to .env (defaults to <cwd>/.env)
 * @param which subset of adapters being loaded — controls which keys we
 *              validate strictly. Pass `["perplexityReasoning", "firecrawl"]`
 *              etc. `"qwenCode"` was removed in INFA-17 because the Qwen
 *              dispatcher is local-CLI only and needs no credential.
 */
export function loadCredentials(
  envPath: string = path.resolve(process.cwd(), ".env"),
  which: AdapterKey[] = ["perplexityReasoning", "perplexityDeepResearch", "firecrawl", "voiceMedia"],
): Credentials {
  const file = readDotenv(envPath);

  // Endpoints Integrator keys.
  //
  // The Qwen dispatcher is now LOCAL-CLI only (dispatcher/qwen.js) and needs
  // no credential. `qwen` on the returned object is preserved only so legacy
  // callers don't crash; `apiKey` is always "" and `baseUrl` is informational.
  const qwenKey = ""; // OBSOLETE — Qwen is local CLI only (INFA-17).
  // Single Perplexity key covers both models; the runtime dispatcher lets
  // each adapter select its own model id.
  const rpKey = which.includes("perplexityReasoning")
    ? requireKey(file, "PERPLEXITY_REASONING_API_KEY", "perplexityReasoning",
        "issue a key at https://www.perplexity.ai/settings/api")
    : (readKey(file, "PERPLEXITY_REASONING_API_KEY") ?? "");
  const drKey = which.includes("perplexityDeepResearch")
    ? requireKey(file, "PERPLEXITY_DEEP_RESEARCH_API_KEY", "perplexityDeepResearch",
        "issue a key at https://www.perplexity.ai/settings/api")
    : (readKey(file, "PERPLEXITY_DEEP_RESEARCH_API_KEY") ?? "");
  const fcKey = which.includes("firecrawl")
    ? requireKey(file, "FIRECRAWL_API_KEY", "firecrawl",
        "issue a key at https://firecrawl.dev")
    : (readKey(file, "FIRECRAWL_API_KEY") ?? "");

  // Voice & Media Engineer keys — presence-checked only
  let whisper = "";
  let eleven = "";
  let elevenVoice = "";
  if (which.includes("voiceMedia")) {
    whisper = requireKey(file, "OPENAI_WHISPER_API_KEY", "voiceMedia",
      "Voice & Media Engineer needs this — issue at https://platform.openai.com/api-keys");
    eleven = requireKey(file, "ELEVENLABS_API_KEY", "voiceMedia",
      "Voice & Media Engineer needs this — issue at https://elevenlabs.io");
    elevenVoice = lookup<string>(file, "ELEVENLABS_VOICE_ID");
  }

  return {
    qwen: { apiKey: qwenKey, baseUrl: "" /* OBSOLETE — see INFA-17 */ },
    perplexityReasoning: { apiKey: rpKey, model: lookup<string>(file, "PERPLEXITY_REASONING_MODEL") },
    perplexityDeepResearch: { apiKey: drKey, model: lookup<string>(file, "PERPLEXITY_DEEP_RESEARCH_MODEL") },
    firecrawl: { apiKey: fcKey, baseUrl: lookup<string>(file, "FIRECRAWL_BASE_URL") },
    media: {
      openaiWhisperApiKey: whisper,
      elevenLabsApiKey: eleven,
      elevenLabsVoiceId: elevenVoice,
    },
    mediaDir: lookup<string>(file, "INFINITY_MEDIA_DIR"),
  };
}

export type AdapterKey =
  | "perplexityReasoning"
  | "perplexityDeepResearch"
  | "firecrawl"
  | "voiceMedia";