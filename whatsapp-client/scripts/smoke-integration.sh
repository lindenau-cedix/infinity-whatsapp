#!/usr/bin/env bash
# Integration smoke: drives the compiled `dist/dispatcher.js` with a fake
# WhatsApp adapter and a fake Integrator factory. Confirms:
#   1. IngressMessage flows through to the right endpoint factory
#   2. Reply text is sent back to the originating group JID
#   3. Special prefixes (voiceReply, grillMe) reach the dispatcher
#   4. Errors from the factory surface as a "Fehler bei …" message
#
# This is the smallest verification that proves the WA<->Integrator seam
# works without needing a real WhatsApp Web session or live API keys.

set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d dist ]; then
  echo "no dist/; run 'npm run build' first" >&2
  exit 1
fi

node scripts/smoke-integration.js