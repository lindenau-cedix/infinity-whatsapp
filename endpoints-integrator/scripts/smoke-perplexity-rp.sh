#!/usr/bin/env bash
# Smoke-test Perplexity sonar-reasoning-pro.
# Usage: ./smoke-perplexity-rp.sh
set -euo pipefail

# Match the adapter's key resolution order (see smoke-perplexity-dr.sh).
API_KEY="${PERPLEXITY_REASONING_API_KEY:-${PERPLEXITY_API_KEY:-}}"
if [ -z "$API_KEY" ]; then
  echo "set PERPLEXITY_API_KEY or PERPLEXITY_REASONING_API_KEY (see .env.example)" >&2
  exit 1
fi
: "${PERPLEXITY_REASONING_MODEL:=sonar-reasoning-pro}"

curl -sS --max-time 120 -w '\n[smoke] http=%{http_code} time=%{time_total}s\n' \
  -X POST \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: smoke-perp-rp-$(date +%s)" \
  "https://api.perplexity.ai/chat/completions" \
  -d "{
    \"model\": \"${PERPLEXITY_REASONING_MODEL}\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Reply with the single word: ok\"}]
  }" | jq . 2>/dev/null || true