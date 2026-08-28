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
    qwenMedia.js          # INFA-27: media analyser; CLI w/ media path
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
| `FIRECRAWL_RECURSE_TOP_K` | `2` | 1–5  | Max NEW URLs Qwen may propose in the second round (the recursion step). |
| `FIRECRAWL_RECURSE_MAX_DEPTH` | `1` | 0–3 | Recursion depth. `0` disables round 2 (single scrape round). |
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

## Media attachments — Qwen image/video analyser (INFA-27)

When the WhatsApp client delivers an image or video, the media store
(`infinity-media`) persists it under `./media/images/` or `./media/videos/`
and forwards the absolute path on `ctx.mediaPaths`. The plain text Qwen
dispatcher ignores those paths, so `register.js` routes any non-empty
`mediaPaths` through a sibling adapter (`dispatcher/qwenMedia.js`) that
shells out to the same `qwen` CLI with the spec-mandated prompt:

```
qwen -m qwen3:30b-a3b -p "Analyse this media: [PATH TO MEDIA SOURCE]"
```

Behaviour:

- `mediaPaths` non-empty + `qwenCode` adapter → analyser path runs, plain
  text adapter never sees the message.
- `mediaPaths` empty or missing → falls back to the existing text-only
  `dispatch(qwenKey, prompt, ctx)` path.
- Non-Qwen endpoints (`perplexityReasoning` / `perplexityDeepResearch` /
  `firecrawl`) are never routed to the analyser — each has its own media
  story (or none).
- Voice attachments are already transcribed upstream by
  `infinity-media/preprocessMessage`, so `mediaPaths` at the dispatcher
  holds the original `.ogg` file but the analyser branch treats it as
  one slot and discards it; voice messages therefore fall through to the
  text path with the Whisper transcript as the prompt (the existing
  behaviour — `Antworte sprachlich` style overrides remain in force).

The branch decision is exposed as `shouldRouteToMediaAnalyser(name, prompt, ctx)`
in `register.js` so future adapter wiring has a single switch to consult.

Tunables (env vars, all optional, same as the plain text path):

| Variable | Default | Effect |
| --- | --- | --- |
| `QWEN_BIN` | `qwen` | Path to the `qwen` CLI on PATH. |
| `QWEN_MODEL` | `qwen3:30b-a3b` | Model name passed via `-m`. |
| `ctx.qwenBin` / `ctx.qwenModel` | — | Per-call overrides (also honoured). |

The analyser's retry envelope is the same `runWithRetry(...)` helper used
by `dispatcher/qwen.js` — 2 attempts, 200 ms base backoff, 120 s per-attempt
deadline (vision analyse can legitimately take longer than chat text).

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