# Infinity — End-to-End Demo Script (INFA-4)

> The "done" check for the WhatsApp → {Qwen, Perplexity RP, Perplexity DR, Firecrawl} client, with voice in/out, Grill-me polls, and Paperclip bridge. Run this against the live system; every step must turn green before we ship.

## 0. Pre-flight (≤ 60 s)

```bash
# 0.1 Project workspace exists and dependencies installed
test -f package.json && node -v   # expect ≥ 18
test -f .env                       # all 6 keys populated (Qwen, Perp RP, Perp DR, Firecrawl, OpenAI, ElevenLabs)
test -f .wa-session.json           # WhatsApp Web session already paired (QR scan complete)

# 0.2 Group registry loaded — exact 4 groups must be present
node -e 'const r=require("./config/groups.json"); for(const k of ["qwen","perp-rp","perp-dr","firecrawl"]) if(!r[k]?.jid) throw new Error(`missing group: ${k}`)'

# 0.3 Boot the daemon and confirm health
npm run start &  # background
curl -fsS localhost:3000/healthz | jq -e '.ok == true and .wa == "ready" and .adapters.qwen == "ready"'
```

Pass criteria: all 3 lines exit 0; `jq` shows `wa=ready` and `adapters.qwen=ready` (Perplexity RP/DR + Firecrawl same).

## 1. Text prompt × 4 groups (happiest path)

For each of the 4 groups, send a unique text prompt. Expect a model reply back in the same group within 30 s, addressed to the bot.

| # | Group key | JID (from groups.json) | Prompt sent | Pass = |
|---|---|---|---|---|
| 1.1 | qwen      | `<qwen-jid>`      | `Summarize Kubernetes liveness vs readiness probes in one paragraph.` | Qwen-style reply with `qwen` in `reply.adapterId`; latency ≤ 30 s; no error text. |
| 1.2 | perp-rp   | `<perp-rp-jid>`   | `What's the difference between TCP and UDP? Reply in three bullets.` | Reply arrives; `reply.adapterId === "perplexity-reasoning-pro"`. |
| 1.3 | perp-dr   | `<perp-dr-jid>`   | `Research current best practices for rate-limiting HTTP APIs in 2025.` | Reply arrives; `reply.adapterId === "perplexity-deep-research"`; body references ≥ 3 sources. |
| 1.4 | firecrawl | `<firecrawl-jid>` | `Crawl https://example.com and return the page title + first paragraph.` | Reply arrives; `reply.adapterId === "firecrawl"`; title matches `<title>` in the crawled HTML. |

Driver (re-run per group):

```bash
./bin/infinity-cli send --group qwen --text "Summarize Kubernetes liveness vs readiness probes in one paragraph."
./bin/infinity-cli wait-reply --group qwen --timeout 30s --expect-adapter qwen
```

Pass criteria: all 4 rows green. Any timeout / wrong-adapter / error-text fail the script.

## 2. Image with path injection

```bash
# 2.1 Drop a known fixture
cp test/fixtures/sample-image.jpg media/inbox/sample-image-$$.jpg
FILE="media/inbox/sample-image-$$.jpg"

# 2.2 Send image + caption in the Qwen group
./bin/infinity-cli send --group qwen --image "$FILE" --caption "What is in this image?"
./bin/infinity-cli wait-reply --group qwen --timeout 30s
```

Pass criteria:
- `media/inbox/sample-image-$$.jpg` exists on disk after send (WhatsApp Client Engineer persisted it).
- The outbound prompt to Qwen contains the literal token `<media:media/inbox/sample-image-$$.jpg>` (Voice & Media Engineer's path-injection).
- Qwen's reply mentions at least one visual element of the fixture (or, if mocked, mentions the filename).

## 3. Voice-in via Whisper

```bash
./bin/infinity-cli send --group qwen --audio test/fixtures/sample-voice.ogg --caption ""
./bin/infinity-cli wait-reply --group qwen --timeout 45s
```

Pass criteria:
- OpenAI Whisper was called exactly once with the OGG file (log line `whisper.transcribed durationMs=…`).
- The transcript contains the known fixture phrase "liveness probes are different from readiness probes" (or whatever the test fixture says — must match `test/fixtures/sample-voice.ogg.txt`).
- Qwen's reply was generated against the transcript, not the empty caption.
- Latency ≤ 45 s (Whisper adds ~5–10 s).

## 4. Voice-out via ElevenLabs (`Antworte sprachlich`)

```bash
./bin/infinity-cli send --group qwen --text "Antworte sprachlich: Was ist der Unterschied zwischen TCP und UDP?"
./bin/infinity-cli wait-reply --group qwen --timeout 45s --expect-voice
```

Pass criteria:
- ElevenLabs TTS was called exactly once (log line `elevenlabs.synthesized voice_id=… bytes=…`).
- The WhatsApp reply is an OGG/opus voice note (not text), duration 5–60 s.
- The spoken text starts with "Der Unterschied zwischen TCP und UDP" (matches the German prompt minus the trigger prefix).
- If ElevenLabs is down: the system falls back to text reply prefixed `🔇 [voice fallback] …` and logs `voice.fallback`. Acceptable but must be logged.

## 5. Grill-me → WhatsApp poll

```bash
./bin/infinity-cli send --group qwen --text "Grill Me: Plane eine Hochzeit für 80 Gäste im Sommer."
./bin/infinity-cli wait-poll --group qwen --timeout 60s
```

Pass criteria:
- The Grill-me skill fires (log line `grillme.start prompt=…`).
- Qwen returns a structured clarifying-questions list (JSON, validated against the poll-option schema).
- WhatsApp receives a `Umfrage` (poll) with ≥ 2 and ≤ 12 options, options in German, header `Klärung: Hochzeit für 80 Gäste`.
- If Qwen returned > 12 questions, the system splits into multiple polls with footer `(1/3)`, `(2/3)`, `(3/3)` — order preserved.
- If poll delivery fails, the system falls back to a numbered text list `1. …\n2. …` and logs `poll.fallback`.

## 6. `/paperclip` slash command → Paperclip event

```bash
# 6.1 Pick any open issue in this project
ISSUE=$(curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues?status=in_progress" \
  | jq -r '.[] | select(.identifier|startswith("INFA")) | .identifier' | head -1)

# 6.2 Fire slash command in Qwen group
./bin/infinity-cli send --group qwen --text "/paperclip status $ISSUE"
./bin/infinity-cli wait-reply --group qwen --timeout 30s
```

Pass criteria:
- Paperclip Bridge Engineer parses `/paperclip status <id>` (log line `paperclip.cmd parsed=…`).
- A `paperclip.event` is emitted and visible on `$ISSUE` as a new comment with body containing the issue's current `status` + `title` + `assigneeAgentId`.
- The WhatsApp reply is `Paperclip: <ISSUE> is <status> — <title>`.
- Re-running the same command within 60 s does **not** create a duplicate comment (idempotency check by `(groupJid, messageId, commandHash)`).

## 7. Negative-path spot checks (smoke)

These don't need to block sign-off, but the integration must log them cleanly:

```bash
# 7.1 Unknown command → reply `Unbekannter Befehl: …`, no Paperclip event
./bin/infinity-cli send --group qwen --text "/paperclip frobnicate"   # expect: error reply, no event

# 7.2 Provider 429 → user-visible retry
# (Manually trigger by hammering the Qwen group 5× in 2 s — expect a 🔁 retrying reply in group, then success)

# 7.3 WhatsApp session drop → re-auth prompt
# (Manual: kill the chromium sub-process — expect log line `wa.session.lost qr=…` and `/healthz` returns `wa=degraded`)
```

## 8. Pass / fail summary

The demo passes when steps 1.1–1.4, 2, 3, 4, 5, 6 are all green within their timeouts, on a single clean run. Step 7's three rows are diagnostic; missing or wrong behaviour on any of them is a follow-up issue but not a hard fail.

| Step | Owner to unblock if red |
|---|---|
| 1.x text prompts | Endpoints Integrator (`06a1c280`) |
| 2 image path injection | WhatsApp Client Engineer (`d1a31c3e`) + Voice & Media Engineer (`3e0a9f42`) |
| 3 voice-in / Whisper | Voice & Media Engineer (`3e0a9f42`) |
| 4 voice-out / ElevenLabs | Voice & Media Engineer (`3e0a9f42`) |
| 5 Grill-me poll | Grill-Me Skill Engineer (`92076658`) |
| 6 /paperclip slash | Paperclip Bridge Engineer (`d3aca56a`) |
| 0 pre-flight / 7 smoke | Integrator / Tech Lead (me, `b963a996`) |

## 9. How to re-run

```bash
make demo             # runs 0 → 7 in order, exits non-zero on first red row
make demo-report      # writes artifacts/demo-report-<ts>.json with per-step timing
```

`make demo` is the canonical "done" gate referenced by INFA-4 acceptance criteria.