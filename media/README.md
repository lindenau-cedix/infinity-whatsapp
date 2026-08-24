# Infinity — Voice & Media

Inbound voice transcription, inbound media persistence, and outbound ElevenLabs TTS for the Infinity WhatsApp client. Path-based media (no base64) on the way in; MP3 file on disk on the way out.

## Layout

```
infinity-media/
  package.json
  README.md
  media/
    _constants.js     # MIME allowlists + max-size caps
    _paths.js         # mediaDir() / mediaFilename() / tts*Dir()
    _download.js      # writeMediaToDisk() — buffer + URL stream
    _errors.js        # MediaError
    image.js          # saveImage()
    video.js          # saveVideo()
    voice.js          # transcribeVoice() (Whisper)
    tts/
      elevenlabs.js   # synthesizeVoice() (ElevenLabs)
    index.js          # preprocessMessage() + public barrel
  tests/
    image.test.js
    video.test.js
    voice.test.js
    index.test.js
    tts/elevenlabs.test.js
    dispatcher/voiceReply.js        # buildVoiceReply() + detectVoicePrefix()
    dispatcher/voiceReply.test.js
```

## Folder layout on disk

Everything lives under the project-local `media/` tree (override with `INFINITY_MEDIA_DIR`):

```
./media/
  images/   <unix_ms>_<id>.<ext>   inbound images
  videos/   <unix_ms>_<id>.<ext>   inbound videos
  voice/    <unix_ms>_<id>.<ext>   inbound voice notes (kept after Whisper)
  tts/      <unix_ms>.mp3          outbound TTS output
```

Filenames are `<unix_ms>_<safeId>.<ext>` so the retention sweep can delete by age.

## Supported MIME types

| Channel | Accept | Cap | Handler |
| --- | --- | --- | --- |
| Image  | `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `image/heic`, `image/heif` | 20 MiB | `saveImage` |
| Video  | `video/mp4`, `video/quicktime`, `video/webm`, `video/3gpp` | 50 MiB | `saveVideo` |
| Voice  | `audio/ogg` (incl. `; codecs=opus`), `audio/opus`, `audio/mpeg`, `audio/mp4`, `audio/x-m4a`, `audio/wav`, `audio/x-wav`, `audio/webm` | 25 MiB | `transcribeVoice` |
| TTS input | text (UTF-8) | n/a | `synthesizeVoice` |
| TTS output | `audio/mpeg` (MP3) | 10 MiB | `synthesizeVoice` |

Anything outside the allowlist throws `MediaError` with `code === "unsupported_mime"` so the WhatsApp Client Engineer can branch on it.

## Public API

```js
import {
  preprocessMessage,   // main entry — what the WhatsApp client calls
  saveImage,           // component
  saveVideo,           // component
  transcribeVoice,     // component
  synthesizeVoice,     // outbound TTS
  buildVoiceReply,     // outbound "Antworte sprachlich" dispatch
  detectVoicePrefix,   // inbound prefix detection
  MediaError,          // error class
  IMAGE_MIME_TYPES,    // allowlists...
  VIDEO_MIME_TYPES,
  VOICE_MIME_TYPES,
  IMAGE_MAX_BYTES,
  VIDEO_MAX_BYTES,
  VOICE_MAX_BYTES,
} from "infinity-media";
```

### `preprocessMessage(rawMessage, opts)`

The single entry point used by the WhatsApp Client Engineer. Returns the prompt envelope adapters expect:

```js
const enriched = await preprocessMessage(rawMessage);
//   enriched.promptText       → text the endpoint gets
//   enriched.mediaPaths       → absolute file paths to inject as PromptContext.mediaPaths
//   enriched.voiceTranscript  → Whisper transcript (or null for non-voice)
```

Branches on `message.mimeType`:
- **Image / video** — bytes saved to `./media/{images,videos}/<ts>_<id>.<ext>`, path added to `mediaPaths`, caption (if any) appended to `promptText`.
- **Voice** — bytes saved to `./media/voice/<ts>_<id>.ogg`, transcript returned as `promptText` and mirrored in `voiceTranscript`. The recording file is kept on disk so the user can re-send without re-downloading.
- **Text** — `promptText` = message text, `mediaPaths` empty, `voiceTranscript` null.

### `transcribeVoice(message, opts)`

Standalone Whisper transcription. `opts.apiKey` defaults to `process.env.OPENAI_WHISPER_API_KEY`; `opts.model` defaults to `whisper-1` (pass `gpt-4o-transcribe` for higher quality). Injects `opts.fetchImpl` for tests.

### `saveImage(message, opts)` / `saveVideo(message, opts)`

Standalone media handlers. Both accept `{ body?: Buffer, url?: string }` and `opts.mediaDir`. `saveVideo` accepts `opts.maxBytes` to override the 50 MiB cap.

### `synthesizeVoice(text, opts)`

Outbound TTS. `opts.apiKey` defaults to `process.env.ELEVENLABS_API_KEY`. Writes the MP3 to `./media/tts/<ts>.mp3`. Throws `MediaError` with code `"tts_failed"` on upstream failure.

### `buildVoiceReply(reply, opts)` / `detectVoicePrefix(prompt)`

Recognise the "Antworte sprachlich" prefix and turn a text reply into an outbound `EgressReply`. On TTS failure, falls back to text with a `[voice fallback]` notice so the user always sees *something*.

## Failure surface

| Code | Thrown by | Meaning |
| --- | --- | --- |
| `unsupported_mime` | image, video, voice | The MIME is not in the allowlist |
| `too_large`        | image, video, voice     | Payload exceeds the channel cap (or content-length header does) |
| `download_failed`  | image, video            | `fetch()` failed or returned non-2xx |
| `transcribe_failed`| voice                   | Whisper rejected the audio or returned empty text |
| `tts_failed`       | synthesizeVoice         | ElevenLabs returned non-2xx or threw |
| `missing_payload`  | all handlers            | Required arg was empty/null |

`MediaError` is a plain `Error` with `.code` so callers can branch:

```js
try { await preprocessMessage(m); }
catch (e) {
  if (e instanceof MediaError && e.code === "unsupported_mime") {
    await sendText("Sorry, I can't read that file type.");
  } else { throw e; }
}
```

## Configuration

All keys come from `.env` (managed by the Endpoints Integrator's credential vault). Tested presence:

```bash
OPENAI_WHISPER_API_KEY=...     # required for transcribeVoice
ELEVENLABS_API_KEY=...         # required for synthesizeVoice
ELEVENLABS_VOICE_ID=...        # optional override; defaults to a German voice
INFINITY_MEDIA_DIR=./media     # optional override
```

### Voice choices (outbound TTS)

`synthesizeVoice` ships with a sensible German default
(`ELEVENLABS_VOICE_ID=onwK4e9ZLuTAKqWW03F9`, ElevenLabs' "Daniel" — a
multilingual DE/EN male voice). Override per-deployment by setting
`ELEVENLABS_VOICE_ID` in `.env` to any voice id from
https://elevenlabs.io/voice-library.

The default model is `ELEVENLABS_MODEL_ID=eleven_multilingual_v2`, which
ships with first-class German. Override to a different ElevenLabs model
(`eleven_turbo_v2_5`, `eleven_flash_v2_5`, etc.) if you need lower latency
or a different prosody.

### Fallback behaviour

If ElevenLabs is unreachable, returns non-2xx, or the audio body is empty,
`synthesizeVoice` throws `MediaError(code="tts_failed")`. The dispatcher
(`buildVoiceReply`) catches that and sends the original text reply prefixed
with `🔇 [voice fallback]` so the user always sees *something*. The
dispatcher logs `voice.fallback` with the upstream error so the integration
test (`demo-script.md` step 4) can assert the fallback path was exercised.

## Tests

```bash
npm test          # node --test "tests/**/*.test.js" — 35 specs
```

No external dependencies. `fetch`, `URL`, `Response`, `Blob`, and `FormData` are all global in Node 18+.

## Out of scope

This module does **not**:

- Call Qwen / Perplexity / Firecrawl — those run via the Endpoints Integrator's `EndpointAdapter`s.
- Shape the "Antworte sprachlich" trigger policy beyond recognising the prefix; the Tech Lead owns the prefix list and the dispatcher that wraps this module.
- Persist credentials or read `process.env` directly for the four endpoint adapters — that's the Endpoints Integrator's `src/credentials.ts`.
- Build the WhatsApp client itself.
