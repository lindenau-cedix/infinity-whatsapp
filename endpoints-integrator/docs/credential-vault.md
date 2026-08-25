# Credential Vault — Infinity

This vault is the **single source of truth** for every third-party API key the
Infinity WhatsApp client touches. The Endpoints Integrator owns the layout,
loader, and rotation notes; everyone else reads through `ctx.credentials`.

## Layout

```
infinity/
  .env.example         # template; checked in
  .env                 # real values; gitignored, never committed
  src/
    credentials.ts     # loader — see below
    adapters/
      perplexityReasoning.ts
      perplexityDeepResearch.ts
      firecrawl.ts
  dispatcher/          # runtime JS dispatcher (consumed by register.js)
    qwen.js            # local Qwen CLI — NO credentials required
    perplexity.js
    firecrawl.js
    shared.js
```

The loader reads `.env` once at process start, validates that every key required
by an active adapter is present and non-empty, and exposes a typed
`Credentials` object. Adapters never read `process.env` directly — they receive
`ctx.credentials` and raise `AuthError` (with the missing key name) when the
caller forgot to wire something up.

## Key map

| Key in vault                          | Owner agent               | Used by adapter                  | Rotation cadence                       |
| ------------------------------------- | ------------------------- | -------------------------------- | -------------------------------------- |
| `QWEN_BIN` / `QWEN_MODEL` *(not secrets)* | Endpoints Integrator   | `dispatcher/qwen.js` (local CLI) | n/a — config, not credentials          |
| `PERPLEXITY_REASONING_API_KEY`        | Endpoints Integrator      | `perplexityReasoning.ts`         | 90 days                                |
| `PERPLEXITY_DEEP_RESEARCH_API_KEY`    | Endpoints Integrator      | `perplexityDeepResearch.ts`      | 90 days                                |
| `FIRECRAWL_API_KEY`                   | Endpoints Integrator      | `firecrawl.ts`                   | 180 days (higher-entropy key)          |
| `OPENAI_WHISPER_API_KEY`              | Voice & Media Engineer    | presence-checked at boot         | 180 days                               |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` | Voice & Media Engineer | presence-checked at boot         | 180 days                               |

Note: the Qwen dispatcher is **local-only** as of INFA-17. There is no
`QWEN_API_KEY` — the adapter spawns the `qwen` CLI
(`qwen -m qwen3:30b-a3b -p "[PROMPT]"`). `QWEN_BIN` lets you override the
binary path and `QWEN_MODEL` overrides the model; both default to the
values in `dispatcher/qwen.js`.

Why split Perplexity into two slots? Perplexity's console issues one key per
account, but keeping two env vars lets us rotate or revoke one product
(reasoning vs. deep-research) without redeploying the other. If you only have
one key, set both env vars to the same value.

## Rotation procedure

1. **Issue** a fresh key in the provider console.
2. **Stage** the new value in `.env.new`; do not overwrite `.env` yet.
3. **Smoke-test** the new key with the adapter's `scripts/smoke-<name>.sh`
   curl harness. Record the response in a comment on the rotation ticket.
4. **Swap** `.env` to the new value and restart the process.
5. **Revoke** the old key in the provider console.
6. **Commit** only the `.env.example` change (if you added a new var). Never
   commit `.env`.

If a leak is suspected (CI log, screenshot, Slack DM, etc.), skip step 3 — rotate
first, smoke-test second.

## Boot-time validation

`credentials.ts` calls `requireKey(name)` for every key the running process
needs. Missing keys raise a single, structured error:

```
AuthError: missing credential "PERPLEXITY_API_KEY"
  → required by adapter "perplexityReasoning"
  → issue a key at https://www.perplexity.ai/settings/api, then add it to .env
```

This is the contract every adapter's `run()` honours. Adapters must not
silently retry on `AuthError`. The Qwen dispatcher does **not** call
`requireKey()` — its only "auth" surface is the local CLI; if `qwen` is not
on `PATH`, the adapter throws a regular `Error` with a pointer to `QWEN_BIN`.

## What the vault is NOT

- Not a KMS / secret manager. Long term, swap the loader for Vault or AWS SM;
  the adapter contract (`ctx.credentials`) stays the same.
- Not a place for WhatsApp session files or OAuth tokens. Those live in the
  WhatsApp client layer.
- Not a place for billing / quota data. That belongs in monitoring.

## Boundary with Voice & Media Engineer

Endpoints Integrator validates the **presence** of `OPENAI_WHISPER_API_KEY` and
`ELEVENLABS_API_KEY` so a misconfigured `.env` fails fast at boot. We do not
read the value. The Voice & Media Engineer reads them directly inside their own
modules. If you need to rotate either, follow the rotation procedure above and
ping the Voice & Media Engineer in the comment thread.