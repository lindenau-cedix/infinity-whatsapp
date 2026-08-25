#!/usr/bin/env bash
# Smoke-test the local Qwen Code CLI.
# Usage: ./smoke-qwen.sh
#
# INFA-17: Qwen is local-CLI only. The CLI is invoked as
#   qwen -m qwen3:30b-a3b -p "[PROMPT]"
# Override the binary via QWEN_BIN and the model via QWEN_MODEL.
set -euo pipefail

: "${QWEN_BIN:=qwen}"
: "${QWEN_MODEL:=qwen3:30b-a3b}"

"${QWEN_BIN}" -m "${QWEN_MODEL}" -p "Reply with the single word: ok"