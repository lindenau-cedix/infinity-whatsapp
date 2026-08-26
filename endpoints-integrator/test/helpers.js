// =============================================================================
// test/helpers.js
//
// Shared test plumbing:
//   - fakeFetch(): stubs global fetch with a per-URL scripted response.
//   - fakeQwenCli(): writes a tiny shell script that prints a canned reply.
//   - withEnv(): temporarily sets env vars for the duration of `fn`.
// =============================================================================

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

function fakeFetch(scripts) {
  const original = global.fetch;
  global.fetch = async (url, init = {}) => {
    const key = String(url);
    if (!Object.prototype.hasOwnProperty.call(scripts, key)) {
      throw new Error(`fakeFetch: no script for ${key}`);
    }
    return scripts[key](init);
  };
  return () => {
    global.fetch = original;
  };
}

function okJson(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Status',
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(data),
    json: async () => data,
  };
}

function okText(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Status',
    headers: { get: () => 'text/plain' },
    text: async () => text,
    json: async () => {
      throw new Error('not json');
    },
  };
}

/**
 * Write a fake `qwen` shell script to a temp file.
 * Returns { binPath, cleanup }. The script prints `reply` to stdout and exits 0.
 * If `failure` is provided the script writes `failure` to stderr and exits 1.
 * If `replies` (array) is provided, each invocation consumes one entry from
 * the FIFO, looping back to the start when the array is exhausted.
 */
async function fakeQwenCli({ reply = 'ok from qwen', failure = null, extraArgs = [], delayMs = 0, replies = null } = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'qwen-fake-'));
  const binPath = path.join(dir, 'qwen');
  const escapedReply = String(reply).replace(/'/g, `'\\''`);
  const failureLine = failure == null
    ? '' // no failure requested → omit assignment so [ -n "$failure" ] is false
    : "failure='" + String(failure).replace(/'/g, `'\\''`) + "'";
  // Build the script with string concatenation (NOT template literals) so that
  // shell $-expansions aren't eaten by JavaScript's template-literal interpolation.
  const lines = [
    '#!/bin/sh',
    '# Fake qwen CLI used by the test harness.',
    '# Args: -m <model> -p <prompt>',
    'delay_ms=' + delayMs,
    "reply='" + escapedReply + "'",
    failureLine,
    'prompt=""',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    -p) prompt="$2"; shift 2 ;;',
    '    *) shift ;;',
    '  esac',
    'done',
    'if [ -n "$failure" ]; then',
    '  printf "%s" "$failure" >&2',
    '  exit 1',
    'fi',
    'if [ "$delay_ms" != "0" ]; then',
    '  sleep "$(awk -v ms="$delay_ms" \'BEGIN{printf "%.3f", ms/1000}\')"',
    'fi',
    // Use a here-string-ish trick: emit the reply only (NOT the prompt) so the
    // dispatcher sees a clean stdout and can decide whether it counts as a reply.
    'printf "%s" "${reply}"',
  ];

  let scriptBody = lines.join('\n') + '\n';

  if (Array.isArray(replies) && replies.length > 0) {
    // Per-invocation FIFO: print reply N, then reply N+1, ... looping.
    // We use a NUL-free record marker that's unlikely to appear in JSON,
    // and store each reply base64-encoded so multi-line strings survive
    // intact (sh read loops split on newlines).
    const SENTINEL = '|||INFINITY_QWEN_RECORD|||';
    const encoded = replies.map((r) => Buffer.from(String(r), 'utf8').toString('base64'));
    const fifoDir = path.join(dir, 'fifo');
    fs.mkdirSync(fifoDir, { recursive: true });
    const linesPath = path.join(fifoDir, 'records');
    fs.writeFileSync(linesPath, encoded.join('\n') + '\n');

    scriptBody = [
      '#!/bin/sh',
      '# Fake qwen CLI with a per-invocation reply FIFO.',
      'delay_ms=' + delayMs,
      "failure='" + String(failure || '').replace(/'/g, `'\\''`) + "'",
      'prompt=""',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    -p) prompt="$2"; shift 2 ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      'if [ -n "$failure" ]; then',
      '  printf "%s" "$failure" >&2',
      '  exit 1',
      'fi',
      'if [ "$delay_ms" != "0" ]; then',
      '  sleep "$(awk -v ms="$delay_ms" \'BEGIN{printf "%.3f", ms/1000}\')"',
      'fi',
      // Atomic rotate: mkdir lockdir is the lock primitive. Read first record,
      // shift the rest, then re-append the record we just consumed so the
      // queue cycles. Records are base64 + NUL-free so multi-line content
      // (including JSON with newlines) survives intact.
      'lockdir="' + fifoDir + '/lock"',
      'queue="' + linesPath + '"',
      'while ! mkdir "$lockdir" 2>/dev/null; do : ; done',
      'trap "rmdir \\"$lockdir\\" 2>/dev/null" EXIT',
      'rec=$(head -n 1 "$queue")',
      'if [ -n "$rec" ]; then',
      '  tail -n +2 "$queue" > "$queue.tmp" && mv "$queue.tmp" "$queue"',
      '  echo "$rec" >> "$queue"',
      'fi',
      'rmdir "$lockdir"',
      // base64-decode and print.
      'printf "%s" "$(printf "%s" "$rec" | base64 -d 2>/dev/null)"',
      '',
    ].join('\n');
  }

  await fs.promises.writeFile(binPath, scriptBody, { mode: 0o755 });
  void extraArgs;
  return {
    binPath,
    cleanup: async () => {
      try {
        await fs.promises.rm(dir, { recursive: true, force: true });
      } catch (_) {}
    },
  };
}

module.exports = { withEnv, fakeFetch, okJson, okText, fakeQwenCli };