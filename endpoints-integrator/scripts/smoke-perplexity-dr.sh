#!/usr/bin/env bash
# Smoke-test Perplexity sonar-deep-research.
# Usage: ./smoke-perplexity-dr.sh
set -euo pipefail

: "${PERPLEXITY_DEEP_RESEARCH_API_KEY:?PERPLEXITY_DEEP_RESEARCH_API_KEY must be set (see .env.example)}"
: "${PERPLEXITY_DEEP_RESEARCH_MODEL:=sonar-deep-research}"

curl -sS -X POST \
  -H "Authorization: Bearer ${PERPLEXITY_DEEP_RESEARCH_API_KEY}" \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: smoke-perp-dr-$(date +%s)" \
  "https://api.perplexity.ai/chat/completions" \
  -d "{
    \"model\": \"${PERPLEXITY_DEEP_RESEARCH_MODEL}\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Reply with the single word: ok\"}]
  }" | jq .