# Infinity — WhatsApp client

The WhatsApp transport for **Infinity**. Connects to WhatsApp Web via
[`whatsapp-web.js`], listens to the four configured groups, downloads
attachments to disk, and hands the resulting `IngressMessage` to the
Endpoints Integrator over a transport-agnostic adapter interface.

This package owns **only** the WhatsApp side of Infinity:

- session lifecycle, QR pairing, reconnect on transient drops
- group JID → endpoint routing config
- attachment persistence (`media/inbox/…`)
- trigger-prefix parsing (`Antworte sprachlich`, `Grill Me:`)

It does **not** call Qwen, Perplexity, Firecrawl, Whisper, or ElevenLabs.
That belongs to the Endpoints Integrator and the Voice & Media Engineer. We
depend on the Integrator's adapter factory, which is injected at boot via
`globalThis.INFINITY_INTEGRATOR_ADAPTERS`. The Integrator ships a glue layer
at `infinity-endpoints-integrator/register.js` that installs the factory on
require — see [Integrator wiring](#integrator-wiring) below.

## Layout

```
infinity/
  src/
    index.ts            # entrypoint: wires config -> adapter -> dispatcher
    cli.ts              # --check-groups, --print-qr helpers
    config.ts           # env loader + group registry
    types.ts            # WhatsAppAdapter interface + IngressMessage / EgressReply
    wwebjsAdapter.ts    # whatsapp-web.js runtime implementation
    dispatcher.ts       # IngressMessage -> Integrator -> EgressReply bridge
    media.ts            # attachment persistence helper
    triggers.ts         # "Antworte sprachlich" / "Grill Me:" prefix parsing
    logger.ts           # structured JSON logger
  test/
    triggers.test.ts    # unit tests for trigger parsing
  scripts/
    smoke-config.sh     # load .env and print the four group JIDs
    smoke-unit.sh       # run the unit tests
  .env.example          # env template — copy to .env
  package.json
  tsconfig.json
```

## Setup

```bash
npm install
cp .env.example .env       # then fill in the four group JIDs
npm run build              # compiles src/ -> dist/
```

The daemon needs a Chromium executable; `npm install` pulls
`puppeteer` transitively via `whatsapp-web.js`. On bare Linux servers, the
common gotchas are missing shared libraries (`libnss3`, `libatk1.0-0`,
`libgbm-dev`, etc.) — install them via your distro's package manager before
starting the daemon.

## QR-code pairing

```bash
# First run, or after --print-qr wipes the session:
npm start
```

The daemon prints a QR code to the terminal. Scan it with the WhatsApp
mobile app → **Settings → Linked Devices → Link a Device**. The session
bundle persists under the path in `WA_SESSION_PATH` (default `./.wa-session`),
so subsequent restarts skip the QR step.

To re-pair (e.g. after rotating the phone that owns the session):

```bash
npx infinity-whatsapp --print-qr   # wipes the session dir
npm start                          # prints a fresh QR
```

## Group routing model

Infinity routes by **WhatsApp group JID**, not by sender. The four groups and
their endpoints are fixed at boot via env vars; messages from any other chat
are silently ignored.

| Env var                       | Endpoint dispatched to        | Group label   |
| ----------------------------- | ------------------------------ | ------------- |
| `WA_GROUP_JID_QWEN`           | Qwen Code                      | `Qwen`        |
| `WA_GROUP_JID_PERP_RP`        | Perplexity `sonar-reasoning-pro` | `Perp. RP`  |
| `WA_GROUP_JID_PERP_DR`        | Perplexity `sonar-deep-research` | `Perp. DR`  |
| `WA_GROUP_JID_FIRECRAWL`      | Firecrawl                      | `Firecrawl`   |

To find a group JID, start the daemon with one group configured, then run
`./bin/infinity-cli send …` (added by the Integrator) or `node -e …` against
the `client.getChats()` API.

## Integrator wiring

The dispatcher expects a factory on `globalThis.INFINITY_INTEGRATOR_ADAPTERS`
that maps a WhatsApp endpoint name (`qwenCode` | `perplexityReasoning` |
`perplexityDeepResearch` | `firecrawl`) to an object with
`{ name, run(prompt, ctx) -> Promise<{ text, mediaRefs, usage? }> }`. The
Integrator workspace ships `register.js`, which:

1. Translates WhatsApp endpoint names → Integrator dispatch keys
   (`qwenCode → qwen`, `perplexityReasoning → perplexity-reasoning-pro`, etc.)
2. Wraps `dispatch(endpointKey, prompt, ctx)` into the `{ name, run }`
   shape so the WhatsApp dispatcher never sees the Integrator's `dispatch()`
   surface.
3. Installs itself on `globalThis` as a side effect of `require('./register.js')`.

To run end-to-end:

```bash
# from the Integrator workspace
node -e "require('./register.js')"   # installs the factory

# from this workspace
node -r <integrator>/register.js dist/index.js
```

When the global is absent, `src/index.ts` falls back to a stub factory that
echoes the request — useful for adapter-only smoke tests.

## Special triggers

Two prefixes are detected **before** the prompt is forwarded to the
Integrator. They are stripped from the body and surfaced as flags on the
`IngressMessage`:

| Prefix                   | Flag on `IngressMessage` | Downstream handler                            |
| ------------------------ | ------------------------ | --------------------------------------------- |
| `Antworte sprachlich`    | `voiceReply: true`       | Voice & Media Engineer renders reply via ElevenLabs |
| `Grill Me:`              | `grillMe: true`          | Grill-Me Skill Engineer produces a poll       |

If both prefixes appear on the same message, both flags are set and the
voice handler wins for reply rendering. The dispatcher does not need to know
either trigger syntax — it just reads the booleans.

## Media

Inbound attachments (image / video / audio / document) are downloaded to
`media/inbox/<transportId>-0.<ext>` before the dispatcher is invoked. The
absolute path is then included as a `MediaRef` on the `IngressMessage`. The
Voice & Media Engineer (Whisper / vision) reads the file from disk — we never
base64-inject attachments into the prompt.

Reply-time attachments produced by the endpoint adapters flow through
`EgressReply.media` and are forwarded as WhatsApp attachments via
`MessageMedia.fromFilePath`.

## Adapter seam

`WhatsAppAdapter` in `src/types.ts` is the transport-agnostic interface.
`WWebJsAdapter` implements it today; the future WhatsApp Business Cloud API
adapter will implement the same interface in a sibling file. The dispatcher
and tests only depend on the interface, so swapping transports is a
one-file change.

## Lifecycle / observability

The daemon writes JSON log lines to stdout. Subscribe with any log
collector. Lifecycle events the WhatsApp adapter emits:

| Event         | When                                                  |
| ------------- | ----------------------------------------------------- |
| `wa.qr`       | A QR code is available (printed to terminal).         |
| `wa.authenticated` | The session is paired.                            |
| `wa.ready`    | The client is connected and listening.                |
| `wa.disconnected` | The chromium sub-process dropped.                 |
| `wa.reconnect.scheduled` | A reconnect attempt is queued (capped exp. backoff). |
| `wa.auth_failure` | Pairing failed — wipe the session and re-pair.   |

Reconnect uses capped exponential backoff (1s → 30s) and gives up after five
failed attempts in a row only as a safety net — most drops reconnect on the
first retry because `whatsapp-web.js` keeps the LocalAuth bundle intact.

## Testing

```bash
bash scripts/smoke-unit.sh    # trigger-parser unit tests (no deps)
bash scripts/smoke-config.sh  # print the four group JIDs from .env
```

The end-to-end four-group smoke test lives in the Integrator / Tech Lead's
workspace (see `demo-script.md` at the project root).

## Boundaries

- We do **not** import Qwen, Perplexity, Firecrawl, Whisper, or ElevenLabs
  SDKs directly. The Integrator owns those clients.
- We do **not** shape Grill-Me poll options. We only forward the
  `grillMe: true` flag.
- We do **not** decide the global message pipeline (which message wins when
  text + image + voice arrive together). That is the Integrator / Tech Lead's
  call; we surface every input we have on `IngressMessage`.

[`whatsapp-web.js`]: https://github.com/pedroslopez/whatsapp-web.js
