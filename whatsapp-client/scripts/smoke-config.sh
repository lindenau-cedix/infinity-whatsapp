#!/usr/bin/env bash
# Smoke test: load config and print the four group JIDs.
# Confirms the env contract before any WhatsApp connection.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "no .env file; copy .env.example to .env and fill in the four group JIDs" >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a; source .env; set +a

node -e '
  const { loadConfig } = require("./dist/config");
  const { groups } = loadConfig();
  for (const [k, v] of Object.entries(groups)) {
    console.log(k.padEnd(22), v.jid, "(label=" + v.label + ")");
  }
'
