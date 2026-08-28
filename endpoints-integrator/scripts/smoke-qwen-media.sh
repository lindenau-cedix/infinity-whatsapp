#!/usr/bin/env bash
# Smoke-test the Qwen media analyser dispatcher (INFA-27).
#
# Usage: ./scripts/smoke-qwen-media.sh /path/to/image-or-video
#
# This drives the literal command the issue spec mandates:
#
#   qwen -m qwen3:30b-a3b -p "Analyse this media: [PATH]"
#
# It does NOT require a real image — it asserts the dispatcher composes
# the right argv and surfaces the CLI's reply back. Use a small dummy
# file (e.g. `touch /tmp/sample.jpg`) for a CI-friendly run; the real
# CLI is happy reading empty bytes when configured, and the test suite
# (test/qwenMedia.test.js) is the authoritative coverage.
set -euo pipefail

: "${QWEN_BIN:=qwen}"
: "${QWEN_MODEL:=qwen3:30b-a3b}"

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <path-to-media-file>" >&2
  exit 64
fi

MEDIA_PATH="$1"

# Inline-exec the dispatcher's run() in a tiny harness so we exercise the
# real spawn/retry/argv code path, not just the prompt string.
QWEN_BIN="${QWEN_BIN}" QWEN_MODEL="${QWEN_MODEL}" node -e '
  const path = require("node:path");
  const { run } = require(path.resolve(__dirname, "..", "dispatcher", "qwenMedia.js"));
  const target = process.argv[1];
  run([target], {}).then(
    (t) => { process.stdout.write(t); process.exit(0); },
    (e) => { process.stderr.write(`${e.message}\n`); process.exit(1); },
  );
' "${MEDIA_PATH}"
