# Infinity Paperclip Bridge

Standalone module that bridges **WhatsApp ↔ Paperclip** for Infinity. Owned by
the Paperclip Bridge Engineer (`d3aca56a`). Integrates with the message
pipeline owned by Integrator / Tech Lead (`b963a996`) without modifying it.

Two directions:

1. **Outbound** — mirror qualifying WhatsApp events onto Paperclip issues
   (`message.received`, `message.replied`, `poll.created`, `error`, plus
   `lifecycle.startup` / `group.registration`).
2. **Inbound** — parse `/paperclip …` slash commands posted in any of the
   four WhatsApp groups and act on them (status check, comment add, optional
   issue creation).

Default policy: events are only attached to **existing** issues. Opt-in
`/paperclip new <title>` opens a new one.

## Layout

```
paperclip-bridge/
  package.json
  README.md
  src/
    index.js     # public barrel
    client.js    # PaperclipClient (HTTP wrapper, rate-limit, idempotency)
    bridge.js    # PaperclipBridge (orchestrator — two directions)
    commands.js  # /paperclip parser
    errors.js    # PaperclipError hierarchy
  test/
    client.test.js
    bridge.test.js
    commands.test.js
```

## Environment

| Var                     | Required | Default       | Notes                                                |
| ----------------------- | -------- | ------------- | ---------------------------------------------------- |
| `PAPERCLIP_API_URL`     | yes      | —             | e.g. `http://localhost:3100/api`. Trailing `/api` is stripped automatically. |
| `PAPERCLIP_API_KEY`     | yes      | —             | Bearer token. Missing/empty → `PaperclipAuthError` at construction. |
| `PAPERCLIP_COMPANY_ID`  | yes      | —             | Required only for `createIssue()`.                   |
| `PAPERCLIP_AGENT_ID`    | no       | —             | Sent as `X-Paperclip-Agent-Id`.                      |
| `PAPERCLIP_RUN_ID`      | no       | —             | Sent as `X-Paperclip-Run-Id`.                       |

All client constructor options (`apiKey`, `apiUrl`, `companyId`, `agentId`,
`runId`, `ratePerSecond`, `burst`, `idempotencyTtlMs`, `idempotencyMax`,
`fetchTimeoutMs`, `fetch`) override the env vars and are used by the test
suite to inject a mocked `fetch`.

## Module API

```js
import {
  PaperclipClient,
  PaperclipBridge,
  createClient,
  parseCommand,
  isPaperclipCommand,
  HELP_TEXT,
  PaperclipError,
  PaperclipAuthError,
  PaperclipTransientError,
  PaperclipProtocolError,
  PaperclipCommandError,
} from "infinity-paperclip-bridge";

const client = new PaperclipClient();            // reads env
const bridge = new PaperclipBridge({ client, defaultIssueId: "<uuid>" });

// --- outbound: mirror events onto a Paperclip issue ---
await bridge.emit({
  kind: "message.received",
  group: "Qwen",
  messageId: "wa-msg-123",
  // issueId optional — falls back to defaultIssueId
});
await bridge.emit({
  kind: "poll.created",
  group: "Perp. RP",
  pollId: "wa-poll-1",
  header: "Klärung",
  options: ["A", "B", "C"],
});
await bridge.emit({
  kind: "error",
  group: "Qwen",
  messageId: "wa-msg-124",
  message: "rate-limited",
  stack: "Error: rate-limited\n  at adapter.run",
});

// --- inbound: route /paperclip commands ---
const out = await bridge.handle("/paperclip status INFA-11", {
  group: "Qwen", messageId: "wa-msg-200",
});
// out = { handled: true, reply: "Paperclip: INFA-11 is in_progress — ...", paperclipEvent: { status: "commented", ... } }
```

## Outbound event schema

All events become Paperclip comments posted to `/api/issues/{id}/comments`.
The body is rendered as Markdown by `renderEventBody()`. Kinds accepted by
`bridge.emit()`:

| `kind`                | Extra fields                                          |
| --------------------- | ----------------------------------------------------- |
| `message.received`    | `group`, `messageId`, `preview?`, `adapterId?`        |
| `message.replied`     | `group`, `messageId`, `adapterId?`, `latencyMs?`, `voice?` |
| `poll.created`        | `group`, `pollId`, `header?`, `options: string[]`     |
| `error`               | `group?`, `messageId?`, `message`, `stack?` (folded into `<details>`) |
| `lifecycle.startup`   | `version?`, `groups: string[]`                        |
| `lifecycle.error`     | `message`, `stack?`                                   |
| `group.registration`  | `group`, `action: "added"\|"removed"`, `jid?`         |

Unknown kinds are silently dropped (no HTTP).

## Inbound slash command grammar

Three accepted prefixes (case-insensitive, leading whitespace tolerated):

```
/paperclip …
paperclip: …
@paperclip …
```

Verbs:

| Verb       | Form                                  | Effect                                                    |
| ---------- | ------------------------------------- | --------------------------------------------------------- |
| `help`     | `/paperclip help`                     | Returns `HELP_TEXT`.                                      |
| `status`   | `/paperclip status <ISSUE>`           | Looks up issue, mirrors status check as comment, returns `Paperclip: <id> is <status> — <title> (assignee: …)`. |
| `comment`  | `/paperclip comment <ISSUE> <body…>`  | Posts body as a comment on the issue.                     |
| `new`      | `/paperclip new <title…>`             | Creates a new issue under the configured company.         |

`<ISSUE>` may be the human identifier (`INFA-11`) or a UUID
(`00467aa7-d71d-4cb3-9704-73a28ce4f4c0`).

Errors:

- `paperclip_command` — local parse error (unknown verb / missing arg).
  Bridge replies with `Paperclip: <message>` plus the help text.
- `paperclip_auth` / `paperclip_transient` / `paperclip_protocol` — server
  errors from Paperclip. Bridge replies with `Paperclip: Fehler — <message>`.

## Idempotency & rate limiting

- **Idempotency.** `PaperclipClient.logEvent()` dedupes by
  `(kind, group, messageId, issueId)` for `idempotencyTtlMs` (default 60 s)
  via an in-memory LRU. Re-delivered WhatsApp messages produce a single
  Paperclip comment. The `status` slash command uses the same key so two
  `/paperclip status INFA-11` calls within 60 s post one status comment.
- **Rate limiting.** Token-bucket per host: `ratePerSecond` (default 10) and
  `burst` (default 20). Exhausted tokens wait in `logEvent()` rather than
  rejecting.

## Error model

```
PaperclipError          // base — has `code`, `status?`, `cause?`
├─ PaperclipAuthError       (401/403) — never silent retry
├─ PaperclipTransientError  (429, 5xx, network, abort) — safe to retry
├─ PaperclipProtocolError   (other 4xx, malformed JSON, missing fields)
└─ PaperclipCommandError    (local: bad slash command)
```

The WhatsApp dispatcher should branch on `error.code` rather than parsing
messages.

## Boundaries

- **Does** call Paperclip's REST API.
- **Does** parse `/paperclip …` commands.
- **Does NOT** modify the message pipeline or reply dispatcher — those are
  owned by Integrator / Tech Lead.
- **Does NOT** call model providers (Qwen, Perplexity, Firecrawl) — this is
  a text-only bridge.
- **Does NOT** initiate outbound WhatsApp replies directly; the
  message pipeline consumes `bridge.handle()` results and dispatches them.

## Tests

```bash
cd paperclip-bridge
node --test test/
```

52 tests, all mocked-HTTP, covering happy + auth-failure (401/403) +
transient (429/500) + protocol (400, malformed JSON) + idempotency +
slash-command grammar paths.

## Demo reference

See `../infinity/demo-script.md` step 6 (`/paperclip slash command →
Paperclip event`). The bridge must satisfy:

- parse `/paperclip status <ISSUE>`,
- emit a `paperclip.event` comment visible on the issue thread,
- reply `Paperclip: <ISSUE> is <status> — <title>` in the WhatsApp group,
- not duplicate when the same command is re-run within 60 s.