#!/usr/bin/env bash
# Smoke-test Firecrawl /v1/scrape.
# Usage: ./smoke-firecrawl.sh
set -euo pipefail

: "${FIRECRAWL_API_KEY:?FIRECRAWL_API_KEY must be set (see .env.example)}"
: "${FIRECRAWL_BASE_URL:=https://api.firecrawl.dev}"

curl -sS -X POST \
  -H "Authorization: Bearer ${FIRECRAWL_API_KEY}" \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: smoke-firecrawl-$(date +%s)" \
  "${FIRECRAWL_BASE_URL}/v1/scrape" \
  -d '{
    "url": "https://example.com",
    "formats": ["markdown"],
    "onlyMainContent": true
  }' | jq .