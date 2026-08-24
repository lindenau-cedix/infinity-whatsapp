#!/usr/bin/env bash
# Smoke-test the Qwen Code (DashScope) endpoint.
# Source the vault first: `set -a; source ../.env; set +a` or export QWEN_API_KEY.
# Usage: ./smoke-qwen.sh
set -euo pipefail

: "${QWEN_API_KEY:?QWEN_API_KEY must be set (see .env.example)}"
: "${QWEN_BASE_URL:=https://dashscope.aliyuncs.com/compatible-mode/v1}"

curl -sS -X POST \
  -H "Authorization: Bearer ${QWEN_API_KEY}" \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: smoke-qwen-$(date +%s)" \
  "${QWEN_BASE_URL}/chat/completions" \
  -d '{
    "model": "qwen-coder",
    "messages": [{"role": "user", "content": "Reply with the single word: ok"}]
  }' | jq .