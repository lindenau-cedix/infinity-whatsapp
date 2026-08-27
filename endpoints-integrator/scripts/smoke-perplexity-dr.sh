#!/usr/bin/env bash
# Smoke-test Perplexity sonar-deep-research.
# Usage: ./smoke-perplexity-dr.sh
set -euo pipefail

# Match the adapter's key resolution order (PERPLEXITY_API_KEY is the
# canonical shared var; the per-model key overrides it). Requiring only the
# per-model key made this script fail on hosts where the shared key is the
# one that's actually set.
API_KEY="${PERPLEXITY_DEEP_RESEARCH_API_KEY:-${PERPLEXITY_API_KEY:-}}"
if [ -z "$API_KEY" ]; then
  echo "set PERPLEXITY_API_KEY or PERPLEXITY_DEEP_RESEARCH_API_KEY (see .env.example)" >&2
  exit 1
fi
: "${PERPLEXITY_DEEP_RESEARCH_MODEL:=sonar-deep-research}"

# INFA-24: deep-research streams NOTHING until the report is complete —
# measured 121s and 185s live, docs say up to 5min. Allow 10min so a slow
# but healthy call isn't misreported as a failure, and show the elapsed
# time because that number is the whole diagnosis when this endpoint misbehaves.
curl -sS --max-time 600 -w '\n[smoke] http=%{http_code} time=%{time_total}s\n' \
  -X POST \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: smoke-perp-dr-$(date +%s)" \
  "https://api.perplexity.ai/chat/completions" \
  -d "{
    \"model\": \"${PERPLEXITY_DEEP_RESEARCH_MODEL}\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Reply with the single word: ok\"}]
  }" | jq . 2>/dev/null || true