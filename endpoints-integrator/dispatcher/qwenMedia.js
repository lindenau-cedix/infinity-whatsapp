// =============================================================================
// dispatcher/qwenMedia.js
//
// INFA-27: when an inbound WhatsApp message carries an image or video
// attachment the WhatsApp Client Engineer persists it to disk and the
// dispatcher fills `ctx.mediaPaths` with the absolute paths. The plain
// `qwen.run` dispatcher is text-only and ignores those paths — Qwen Code
// never sees the file. This adapter composes the prompt around the
// saved media path and shells out to the same `qwen` CLI:
//
//   qwen -m qwen3:30b-a3b -p "Analyse this media: [PATH TO MEDIA SOURCE]"
//
// Spec from INFA-27:
//   > If a Image or Video is sent with whatsapp it should get saved in a
//   > folder and then qwen code should get started with the following
//   > command: 'qwen -m qwen3:30b-a3b -p "Analyse this media: [PATH TO
//   > MEDIA SOURCE]"' and then its answer should get sent back normally
//   > via whatsapp again.
//
// When more than one media path is present (a gallery-style send where the
// WhatsApp Web client delivers several images at once) we analyse the
// first one only and inline-mention the rest, since the Qwen CLI accepts
// exactly one positional `analyse` target. The full file list also ends
// up on `ctx.mediaPaths`, so future multi-modal adapters can pick them up
// without re-fetching.
//
// Behaviour:
//   - Calls the same `qwen` binary via `child_process.spawn` — NO shelling
//     through bash, NO `cd`, NO env override beyond PATH so the operator
//     can swap the binary with `QWEN_BIN`.
//   - Re-uses the retry / timeout helpers in `shared.js` (same envelope
//     as the plain Qwen dispatch path; media analysis is just a slower
//     `qwen` run).
//   - Surfaces stderr / ENOENT / exit-code failures with the exact
//     diagnostics the operator needs.
//   - Defaults the path slot to the FIRST media path (image/video only).
//     Voice attachments are excluded — they are already transcribed by the
//     Voice & Media Engineer before the dispatcher is reached; the analyser
//     only runs on what Qwen Code can actually read from a file path.
// =============================================================================

'use strict';

const { runWithRetry, trimForReply } = require('./shared.js');

const DEFAULT_MODEL = 'qwen3:30b-a3b';
const MAX_PROMPT_CHARS = 32_000; // matches qwen.js — keep argv length bounded

/**
 * Build the prompt the CLI receives. The literal text mirrors the issue's
 * command verbatim, with the absolute media path interpolated in. Extra
 * paths (when the WA client delivered a multi-image send) are appended as
 * a note so the operator can see them in `qwen`'s stderr / logs.
 */
function buildPrompt(mediaPaths) {
  const primary = mediaPaths[0];
  const extras = mediaPaths.slice(1);
  let prompt = `Analyse this media: [${primary}]`;
  if (extras.length > 0) {
    prompt +=
      `\n\nAdditional saved attachments (not analysed here, listed for context):\n` +
      extras.map((p) => `  - ${p}`).join('\n');
  }
  // Same defensive cap as the plain text path — Qwen CLI argv handling has
  // a practical ceiling around ~64k, so keep the wrapped prompt under 32k.
  if (prompt.length > MAX_PROMPT_CHARS) {
    return prompt.slice(0, MAX_PROMPT_CHARS) + '\n[…truncated for CLI argv…]';
  }
  return prompt;
}

function resolveModel(ctx) {
  return (
    ctx.qwenModel ||
    process.env.QWEN_MODEL ||
    DEFAULT_MODEL
  );
}

function resolveBinary(ctx) {
  return (
    ctx.qwenBin ||
    process.env.QWEN_BIN ||
    'qwen'
  );
}

function invokeCli(bin, args, { signal }) {
  // Lazy-load child_process so unit tests that never reach the spawn path
  // don't pay for the import. Mirrors qwen.js.
  // eslint-disable-next-line global-require
  const { spawn } = require('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString('utf8')));
    child.stderr.on('data', (b) => (stderr += b.toString('utf8')));

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        const e = new Error(
          `qwen CLI not found at "${bin}". Set QWEN_BIN or install qwen (https://github.com/QwenLM/Qwen3-Coder).`,
        );
        e.code = 'ENOENT';
        reject(e);
      } else {
        reject(err);
      }
    });
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const e = new Error(
        `qwen media CLI exited with code ${code}: ${stderr.trim().slice(0, 500)}`,
      );
      e.code = code;
      e.stderr = stderr;
      reject(e);
    });
  });
}

/**
 * Run the media analyser. Thin wrapper around `qwen -m <model> -p "Analyse
 * this media: [PATH]"` with the same retry / timeout envelope the text
 * path uses.
 *
 * @param {string[] | undefined | null} mediaPaths
 *   Absolute filesystem paths the media handler saved on the WA side.
 *   Empty / missing ⇒ throws synchronously (the caller should have guarded).
 * @param {object} [ctx]
 *   Standard Integrator context. `qwenBin` / `qwenModel` honoured like the
 *   plain text path.
 * @returns {Promise<string>}  the assistant's text reply to send back
 */
async function run(mediaPaths, ctx = {}) {
  if (!Array.isArray(mediaPaths) || mediaPaths.length === 0) {
    throw new TypeError(
      'qwenMedia.run: mediaPaths is required and must contain at least one image or video path',
    );
  }
  const bin = resolveBinary(ctx);
  const model = resolveModel(ctx);
  const prompt = buildPrompt(mediaPaths);

  const result = await runWithRetry(
    ({ signal }) =>
      invokeCli(bin, ['-m', model, '-p', prompt], { signal }),
    {
      adapter: 'qwen-media',
      attempts: 2,         // CLI is local; one retry is plenty
      baseDelayMs: 200,
      timeoutMs: 120_000,  // vision analyse can take longer than text chat
    },
  );

  const text = (result.stdout || '').trim();
  if (!text) {
    throw new Error(
      `qwen-media: empty reply from CLI. stderr=${(result.stderr || '').trim().slice(0, 300)}`,
    );
  }
  return trimForReply(text);
}

module.exports = {
  run,
  buildPrompt,
  DEFAULT_MODEL,
  resolveBinary,
  resolveModel,
};
