# Infinity WhatsApp Services

A WhatsApp client that delegates prompts to external AI endpoints
(Qwen Code, Perplexity *sonar-reasoning-pro* and *sonar-deep-research*,
Firecrawl) and ships with built-in support for media attachments, voice
messaging, ElevenLabs TTS replies, and the *Grill Me* clarification poll skill.

## Architecture at a glance

```
                     ┌──────────────────────────────────┐
 WhatsApp (groups) ─►│  whatsapp-web.js client          │  whatsapp-client/
                     │   + Antworte sprachlich / Grill  │
                     │     Me: / paperclip: triggers    │
                     └──────────────┬───────────────────┘
                                    │ (AdapterFactory)
                                    ▼
                     ┌──────────────────────────────────┐
                     │  Endpoints + credential vault    │  endpoints-integrator/
                     │   Qwen Code                      │
                     │   Perplexity sonar-reasoning-pro │
                     │   Perplexity sonar-deep-research │
                     │   Firecrawl /v1/scrape           │
                     └──────────────────────────────────┘

 Sidecars (called from the client before / after dispatch):
   media/             image/video persistence, OpenAI Whisper STT,
                      ElevenLabs TTS (Antworte sprachlich reply path)
   skills/grillme/    Grill Me: Qwen meta-prompt + WhatsApp poll parser
   paperclip-bridge/  outbound event mirror + paperclip: slash commands
```

## Packages

| Folder | Role | Entry point |
| --- | --- | --- |
| `whatsapp-client/` | whatsapp-web.js daemon, group routing, prefix triggers | `src/index.ts` (build: `dist/`) |
| `endpoints-integrator/` | Credential vault + Qwen / Perplexity RP / Perplexity DR / Firecrawl adapters | `register.js`, `src/index.ts`, `dispatcher/index.js` |
| `media/` | Image / video download, Whisper transcription, ElevenLabs TTS | `media/index.js` |
| `skills/grillme/` | *Grill Me:* Qwen meta-prompt + WhatsApp poll parser | `index.js` |
| `paperclip-bridge/` | Outbound event mirror, `paperclip:` slash commands | `src/index.js` |

## Trigger prefixes

The WhatsApp client strips these prefixes before delegating to the
endpoint adapter:

| Prefix | Behaviour |
| --- | --- |
| `Antworte sprachlich` | The endpoint's reply text is rendered to audio via ElevenLabs and sent as a voice message. |
| `Grill Me:` | Qwen is asked what additional information it needs; the reply is parsed into a sequence of WhatsApp polls (*Umfrage*) the user can answer. |
| `paperclip:` | Interpreted as a Paperclip command (e.g. `paperclip: issue <title>`); handled by the paperclip-bridge package. |

Inbound attachments are saved to a folder and the path is injected
into the prompt. Inbound voice notes are transcribed via OpenAI Whisper
and the transcript is used as the prompt.

## WhatsApp groups

One group per endpoint:

1. **Qwen Code** — `qwen -m qwen3:30b-a3b -p "<prompt>"`.
2. **Perplexity RP** — `sonar-reasoning-pro`.
3. **Perplexity DR** — `sonar-deep-research`.
4. **Firecrawl** — `/v1/scrape` (URL → extracted content).

## Configuration

Each package ships its own `.env.example`. Real credentials are loaded
by the endpoint integrator's credential vault (`endpoints-integrator/src/credentials.ts`).
Required keys:

| Key | Used by |
| --- | --- |
| `OPENAI_API_KEY` | Whisper transcription (media) |
| `ELEVENLABS_API_KEY` | TTS reply for *Antworte sprachlich* (media) |
| `ELEVENLABS_VOICE_ID` | Default voice for TTS |
| `PERPLEXITY_API_KEY` | Both Perplexity endpoints |
| `FIRECRAWL_API_KEY` | Firecrawl scraper |
| `QWEN_CLI_BIN` | Path to `qwen` CLI (e.g. `qwen`) |
| `QWEN_CLI_MODEL` | Model name (default `qwen3:30b-a3b`) |
| `PAPERCLIP_API_KEY` | paperclip-bridge outbound calls |
| `PAPERCLIP_API_URL` | Paperclip API base (e.g. `http://localhost:3100`) |

The WhatsApp client is configured to point at the endpoints package
via `register.js`, which exposes `globalThis.INFINITY_INTEGRATOR_ADAPTERS(name)`.

## Build & run

```bash
# WhatsApp client
cd whatsapp-client
npm install
npm run build          # produces dist/
npm start              # scans QR on first run

# Endpoints integrator (required by the client at runtime)
cd ../endpoints-integrator
npm install
node register.js       # exposes the adapter factory
```

## Hand-off

See [`docs/HANDOFF.md`](docs/HANDOFF.md) for the full per-package file
index, owner mapping, and an issue tracker snapshot.
