#!/usr/bin/env bash
# Smoke-test Firecrawl — all three modes the adapter supports (INFA-22 + INFA-23):
#
#   1. URL-in-prompt (legacy path):  send a literal URL → /v1/scrape.
#   2. Free-form pick-one:           Qwen picks a URL → /v1/scrape.
#   3. Recursive research (INFA-23): Qwen query → /v2/search → Qwen rank
#                                    → /v1/scrape per pick → Qwen compose.
#
# Set FIRECRAWL_API_KEY and (optionally) FIRECRAWL_BASE_URL. Modes 2 and 3
# additionally need the local `qwen` CLI on PATH (or QWEN_BIN).
#
# Pretty-prints the response JSON via scripts/_pretty_json.sh (tries jq,
# then node, then python3, then raw) so this works in any minimal runtime.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_pretty_json.sh
. "${SCRIPT_DIR}/_pretty_json.sh"

: "${FIRECRAWL_API_KEY:?FIRECRAWL_API_KEY must be set (see .env.example)}"
: "${FIRECRAWL_BASE_URL:=https://api.firecrawl.dev}"

MODE="${1:-url}"   # url | freeform | research

require_qwen() {
  QWEN_BIN="${QWEN_BIN:-qwen}"
  if ! command -v "${QWEN_BIN}" >/dev/null 2>&1; then
    echo "smoke-firecrawl: qwen CLI not found at '${QWEN_BIN}'." >&2
    echo "  → install from https://github.com/QwenLM/Qwen3-Coder, or set QWEN_BIN=<path>." >&2
    echo "  → (the URL-in-prompt mode still works without qwen)" >&2
    exit 2
  fi
}

case "${MODE}" in
  url)
    echo "smoke-firecrawl: URL-in-prompt mode → /v1/scrape with literal URL"
    curl -sS -X POST \
      -H "Authorization: Bearer ${FIRECRAWL_API_KEY}" \
      -H "Content-Type: application/json" \
      -H "X-Request-Id: smoke-firecrawl-url-$(date +%s)" \
      "${FIRECRAWL_BASE_URL}/v1/scrape" \
      -d '{
        "url": "https://example.com",
        "formats": ["markdown"],
        "onlyMainContent": true
      }' | pretty_json
    ;;
  freeform)
    require_qwen
    echo "smoke-firecrawl: free-form-prompt mode → run dispatcher with a free question"
    node -e '
      const { run } = require("./dispatcher/firecrawl.js");
      run("Look up the best API for package tracking.", {
        requestId: "smoke-firecrawl-freeform",
      })
        .then((t) => { console.log(t); })
        .catch((e) => { console.error("firecrawl failed:", e.message); process.exit(1); });
    '
    ;;
  search)
    # Smoke just the Firecrawl /v2/search endpoint directly so operators can
    # verify the search leg of the recursive pipeline without running Qwen.
    echo "smoke-firecrawl: /v2/search only (INFA-23 search leg)"
    curl -sS -X POST \
      -H "Authorization: Bearer ${FIRECRAWL_API_KEY}" \
      -H "Content-Type: application/json" \
      -H "X-Request-Id: smoke-firecrawl-search-$(date +%s)" \
      "${FIRECRAWL_BASE_URL}/v2/search" \
      -d '{
        "query": "package tracking API",
        "sources": ["web"],
        "limit": 5
      }' | pretty_json
    ;;
  research)
    require_qwen
    echo "smoke-firecrawl: recursive research mode → Qwen query → /v2/search → Qwen rank → scrape → Qwen compose"
    node -e '
      const { run } = require("./dispatcher/firecrawl.js");
      run("Was sind die wichtigsten Vorteile von PostgreSQL gegenüber MySQL?", {
        requestId: "smoke-firecrawl-research",
      })
        .then((t) => { console.log(t); })
        .catch((e) => { console.error("firecrawl failed:", e.message); process.exit(1); });
    '
    ;;
  *)
    echo "smoke-firecrawl: unknown mode '${MODE}'. Use 'url', 'freeform', 'search', or 'research'." >&2
    exit 64
    ;;
esac
