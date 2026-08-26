# Infinity — Endpoints Integrator

Adapter package for the four model backends behind the Infinity WhatsApp client.

## Layout

```
infinity/
  .env.example            # credential vault template — copy to .env
  README.md
  docs/
    credential-vault.md   # key source-of-truth, rotation, access semantics
  scripts/
    smoke-qwen.sh
    smoke-perplexity-rp.sh
    smoke-perplexity-dr.sh
    smoke-firecrawl.sh
  src/
    credentials.ts        # vault loader (AuthError on missing key)
    types.ts              # EndpointAdapter, PromptContext, Reply
    index.ts              # public barrel + getAdapter()
    adapters/
      perplexityReasoning.ts
      perplexityDeepResearch.ts
      firecrawl.ts
  dispatcher/             # runnable JS adapters; Qwen CLI lives here
    index.js
    qwen.js               # local CLI; no API key, no HTTP
    perplexity.js
    firecrawl.js
    shared.js             # envKey, runWithRetry, trimForReply
```

## Quick start

```bash
cp .env.example .env
# fill in real keys (PERPLEXITY_API_KEY, FIRECRAWL_API_KEY)
# Qwen Code is local-only — install the CLI on PATH; see QWEN_BIN below.
chmod +x scripts/*.sh
PERPLEXITY_API_KEY=... ./scripts/smoke-perplexity-rp.sh
FIRECRAWL_API_KEY=...    ./scripts/smoke-firecrawl.sh
# Local-CLI smoke — no key needed:
./scripts/smoke-qwen.sh
```

## Firecrawl group — INFA-22 free-form prompts

The Firecrawl WhatsApp group accepts both shapes:

- A literal URL (legacy fast path): `scrape https://example.com` → Firecrawl
  is called directly with that URL.
- A free-form question (INFA-22): e.g. `Look up the best API for package
  tracking.` → the local Qwen CLI picks a single URL that best answers the
  question, then Firecrawl scrapes it. Qwen is told to reply with one JSON
  line `{"url":"https://…"}` (or `{"url":null,"reason":"…"}` when it can't
  decide) so the parser stays robust against fence / prose.

Smoke test:

```bash
./scripts/smoke-firecrawl.sh url         # literal URL → /v1/scrape
./scripts/smoke-firecrawl.sh freeform    # Qwen picks URL → /v1/scrape
```

The free-form mode needs the local `qwen` CLI on `PATH` (or `QWEN_BIN`).
The URL-in-prompt mode has no Qwen dependency.

## Adapter contract

```ts
interface EndpointAdapter {
  readonly name: string;
  run(prompt: string, ctx: PromptContext): Promise<Reply>;
}

interface Reply {
  text: string;
  mediaRefs: MediaRef[];   // path references, never base64
  usage?: { inputTokens?: number; outputTokens?: number; latencyMs?: number };
}
```

The dispatcher passes `ctx.credentials` — adapters never read `process.env`
directly. See `docs/credential-vault.md` for the full vault contract.

## Boundaries

- Outbound text only. No WhatsApp I/O, no transcription, no TTS.
- Media is referenced by server-side path. We do not base64-inject.
- Adapters return `AuthError` (with the missing key name) on bad creds —
  they do not silently retry.

## Voice-out ("Antworte sprachlich")

The Integrator / Tech Lead's `MessagePipeline` detects the German trigger
prefix `"Antworte sprachlich"` (case-insensitive, leading whitespace
tolerated), strips it, runs the chosen adapter, and then delegates to the
Voice & Media Engineer's `infinity-media` package to render the reply as
audio and send it back as a voice note. On TTS failure the dispatcher
falls back to a text reply prefixed with `🔇 [voice fallback]`. See
`infinity-media/media/tts/elevenlabs.js` and
`infinity-media/media/dispatcher/voiceReply.js`, plus the env-var / voice
choices documented in `infinity-media/README.md`.