#!/usr/bin/env bash
# Smoke-test Perplexity sonar-reasoning-pro.
# Usage: ./smoke-perplexity-rp.sh
set -euo pipefail

: "${PERPLEXITY_REASONING_API_KEY:?PERPLEXITY_REASONING_API_KEY must be set (see .env.example)}"
: "${PERPLEXITY_REASONING_MODEL:=sonar-reasoning-pro}"

curl -sS -X POST \
  -H "Authorization: Bearer ${PERPLEXITY_REASONING_API_KEY}" \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: smoke-perp-rp-$(date +%s)" \
  "https://api.perplexity.ai/chat/completions" \
  -d "{
    \"model\": \"${PERPLEXITY_REASONING_MODEL}\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Reply with the single word: ok\"}]
  }" | jq .