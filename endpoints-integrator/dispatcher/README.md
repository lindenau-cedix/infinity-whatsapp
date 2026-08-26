# Infinity — Endpoints Integrator

Endpoint dispatchers for the Infinity WhatsApp client. The four adapters are:

| Dispatcher key                  | Model / Endpoint                          | Path                                      |
| ------------------------------- | ----------------------------------------- | ----------------------------------------- |
| `qwen`                          | Qwen Code CLI (`qwen -m qwen3:30b-a3b`)   | `dispatcher/qwen.js`                      |
| `perplexity-reasoning-pro`      | Perplexity `sonar-reasoning-pro`          | `dispatcher/perplexity.js` (model=…)     |
| `perplexity-deep-research`      | Perplexity `sonar-deep-research`          | `dispatcher/perplexity.js` (model=…)     |
| `firecrawl`                     | Firecrawl `/v1/scrape`                    | `dispatcher/firecrawl.js`                  |

All four are wired together by `dispatcher/index.js`, exposing a single
`dispatch(endpointKey, prompt, ctx) → Promise<string>` switch consumed by the
WhatsApp client engineer.

## Layout

```
infinity/
  package.json                 # npm test → node --test test/
  dispatcher/
    index.js                   # dispatch(endpointKey, prompt, ctx)
    shared.js                  # envKey, runWithRetry, AuthError, DispatcherError, trimForReply
    qwen.js                    # local Qwen CLI adapter
    perplexity.js              # Perplexity chat-completions (both models)
    firecrawl.js               # Firecrawl /v1/scrape
  test/
    helpers.js                 # fakeFetch / fakeQwenCli / withEnv
    qwen.test.js
    perplexity.test.js
    firecrawl.test.js
    dispatch.test.js
```

## Environment variables

| Var                              | Required by                  | Default                                            | Notes                                                                                          |
| -------------------------------- | ---------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `QWEN_BIN`                       | qwen                         | `qwen`                                             | Path to the Qwen CLI. Override only if it's not on `PATH`.                                     |
| `QWEN_MODEL`                     | qwen                         | `qwen3:30b-a3b`                                    | Override per-INFA-7 spec; per-message override via `ctx.qwenModel`.                             |
| `PERPLEXITY_API_KEY`             | perplexity (both models)     | — (required)                                       | One key covers both models unless you split per-product (not currently exposed via env).       |
| `PERPLEXITY_BASE_URL`            | perplexity                   | `https://api.perplexity.ai`                        | Override for self-hosted gateways.                                                             |
| `FIRECRAWL_API_KEY`              | firecrawl                    | — (required)                                       | Issue at https://firecrawl.dev.                                                                |
| `FIRECRAWL_BASE_URL`             | firecrawl                    | `https://api.firecrawl.dev`                        | Override for self-hosted Firecrawl.                                                            |

The vault template lives at `infinity/.env.example`. Real values go in `infinity/.env` (gitignored).

## Installing & running

```bash
# 1. Install Node ≥ 18 and clone the repo
node -v                              # expect ≥ 18

# 2. Configure the vault
cd infinity
cp .env.example .env
$EDITOR .env                          # fill in PERPLEXITY_API_KEY, FIRECRAWL_API_KEY

# 3. Install the Qwen CLI (only required for the qwen dispatcher)
#    See https://github.com/QwenLM/Qwen3-Coder for install instructions.
qwen -m qwen3:30b-a3b -p "hi"         # smoke

# 4. Run the unit tests — no live API keys required
npm test
```

## Public API

```js
const { dispatch, listEndpoints } = require('./dispatcher/index.js');

await dispatch('qwen',                          'Summarize Kubernetes liveness probes', {
  requestId: 'req-1', group: 'Qwen', mediaPaths: ['/abs/path/to/img.jpg'],
});
await dispatch('perplexity-reasoning-pro',      'What is the difference between TCP and UDP?', {
  requestId: 'req-2', group: 'Perp. RP',
});
await dispatch('perplexity-deep-research',      'Research current best practices for rate-limiting HTTP APIs in 2025.', {
  requestId: 'req-3', group: 'Perp. DR',
});
await dispatch('firecrawl',                     'Crawl https://example.com', {
  requestId: 'req-4', group: 'Firecrawl',
});

listEndpoints();  // ['qwen', 'perplexity-reasoning-pro', 'perplexity-deep-research', 'firecrawl']
```

`dispatch()` returns a `Promise<string>` — the outbound text the WhatsApp
client should send back to the user.

## Prompt-format conventions

These are *upstream* of the dispatcher — the WhatsApp client (or the Grill-Me
skill / Voice & Media Engineer) is responsible for stripping prefixes and
shaping the prompt before it lands here.

| Prefix on inbound message       | Pre-dispatch behaviour                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `Grill Me: <topic>`            | Strip the prefix; the Grill-Me Skill Engineer then asks the model for clarifying Qs and shapes a WhatsApp `Umfrage`. The dispatcher only sees the cleaned prompt. |
| `Antworte sprachlich: <text>`  | Strip the prefix; the outbound envelope carries `voice: true` so the Voice & Media Engineer hands the reply to ElevenLabs. The dispatcher still returns plain text. |
| Media (image / video / audio)  | Voice & Media Engineer saves the file under `media/inbox/...` and passes the absolute path as `ctx.mediaPaths[i]`. Adapters do **not** read the file — they pass the path reference through. No base64 injection. |

Each adapter returns text only; media returned by the model (e.g. a chart) is
out of scope for this issue and lands in the broader Endpoints Integrator
contract via `Reply.mediaRefs` (see `../src/types.ts`).

## Errors

The dispatcher throws two structured error types:

- `AuthError` (`name = 'AuthError'`, `key`, `adapter`) — missing credential.
  Adapters raise this *immediately* on boot of the request and do not retry.
- `DispatcherError` (`name = 'DispatcherError'`, `adapter`, `cause`) — wraps a
  retried call after the retry budget is exhausted. The upstream message lives
  on `error.cause.message`.

Upstream 4xx (other than 401/403) and 5xx are wrapped in `DispatcherError` and
surface to the WhatsApp client verbatim.

## Live smoke tests

`scripts/smoke-*.sh` exercise the upstream providers with curl. They require
real keys — fill `.env` first and source it.

```bash
set -a; source .env; set +a
./scripts/smoke-qwen.sh
./scripts/smoke-perplexity-rp.sh
./scripts/smoke-perplexity-dr.sh
./scripts/smoke-firecrawl.sh
```

## Deploy note: dual-tree copy (INFA-24)

The runtime daemon loads this package from a *non-git snapshot* at
`/paperclip/instances/default/workspaces/06a1c280-…/infinity/`, not from the
git checkout in `d1a31c3e-…`. When you commit a fix here, you MUST also copy
the changed files into the agent-workspace tree, otherwise the daemon keeps
running the stale code and the user sees the same error after every "fix".

Quick sync command (run from this repo root):

```bash
SRC=/paperclip/instances/default/workspaces/d1a31c3e-87c9-4dbc-b3cd-73e3dee95ae5/infinity/endpoints-integrator
DST=/paperclip/instances/default/workspaces/06a1c280-6f20-443c-93b0-48e9e50190af/infinity
cp -af "$SRC/dispatcher/." "$DST/dispatcher/"
cp -af "$SRC/src/."      "$DST/src/"
cp -af "$SRC/test/."     "$DST/test/"
cp -af "$SRC/scripts/."  "$DST/scripts/"
cp -af "$SRC/docs/."     "$DST/docs/"
cp -af "$SRC/register.js" "$DST/register.js"
cp -af "$SRC/README.md"  "$DST/README.md"
( cd "$DST" && node --test test/ )
```

Then post a status comment on the issue so the operator knows to restart the
daemon and re-test.

## Boundaries (recap)

- Outbound text only — no WhatsApp I/O, no transcription, no TTS.
- Media returned as path references; never base64-injected.
- We never read `process.env` from inside adapter modules other than via
  `envKey(...)` in `dispatcher/shared.js` (which raises `AuthError` with a
  remediation hint when the value is missing).