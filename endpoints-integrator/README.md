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
      qwenCode.ts
      perplexityReasoning.ts
      perplexityDeepResearch.ts
      firecrawl.ts
```

## Quick start

```bash
cp .env.example .env
# fill in real keys
chmod +x scripts/*.sh
QWEN_API_KEY=... ./scripts/smoke-qwen.sh
```

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