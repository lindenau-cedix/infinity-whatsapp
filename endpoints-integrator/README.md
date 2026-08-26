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

## Firecrawl group — free-form + recursive research (INFA-22 + INFA-23)

The Firecrawl WhatsApp group accepts three execution shapes; the dispatcher
selects the right one from the prompt:

- **URL-in-prompt (fast path).** `scrape https://example.com` → Firecrawl
  `/v1/scrape` is called directly with that URL. No model call.
- **Free-form pick-one (INFA-22).** Short imperative without a URL → the
  local Qwen CLI picks **one** URL that best answers the question; we then
  `/v1/scrape` it. Used for "fetch …" / "scrape …" requests.
- **Recursive research (INFA-23).** Open research question (heuristic: `?`,
  German/English question word, trigger phrases like "explain …" / "tell me
  about …", or prompt length ≥ 60 chars, AND not starting with an imperative
  fetch verb). Pipeline:
  1. ask Qwen to derive a Google-style search query from the prompt,
  2. POST Firecrawl `/v2/search` with `sources: ["web"]` and a small
     `limit` (default 5),
  3. ask Qwen to rank the results and pick the top K (default 3),
  4. POST `/v1/scrape` for each chosen URL, bounded by
     `FIRECRAWL_RECURSE_MAX_CHARS` so the final Qwen step stays within its
     CLI argv budget (default 12 000 chars total),
  5. ask Qwen to compose a pretty-formatted German answer with a `*Quellen*`
     block at the end citing each source by title + URL.

Every step has its own timeout. Failures surface inline — never a silent
wrong URL. Provider errors are returned as friendly text rather than
thrown, so the WhatsApp group stays visibly alive when the key is bad.

Smoke tests:

```bash
# Fast path / direct curl — no Qwen needed.
./scripts/smoke-firecrawl.sh url

# Search-only sanity check against the live API.
./scripts/smoke-firecrawl.sh search

# Free-form pick-one — needs the local `qwen` CLI on PATH (or QWEN_BIN).
./scripts/smoke-firecrawl.sh freeform

# Full recursive research pipeline (Qwen query → search → rank → scrape →
# compose). Needs Qwen + a real Firecrawl key.
./scripts/smoke-firecrawl.sh research
```

Tunables (env vars, all optional):

| Variable | Default | Range | Effect |
| --- | --- | --- | --- |
| `FIRECRAWL_SEARCH_LIMIT` | `5` | 1–10 | Max results `/v2/search` returns per source. |
| `FIRECRAWL_PICK_TOP_K`   | `3` | 1–5  | How many of those Qwen is allowed to pick for the deep scrape. |
| `FIRECRAWL_RECURSE_MAX_CHARS` | `12000` | 2000–40000 | Total markdown budget across all chosen sources before composition. |

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