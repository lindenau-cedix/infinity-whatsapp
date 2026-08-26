#!/usr/bin/env bash
# Unit tests for the trigger parser and the group-JID config validation.
# Compiles the test sources on the fly via `tsc` with a tiny override config
# so we don't need a separate test runner (mocha / vitest would balloon the
# install).
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -d node_modules ]; then
  echo "no node_modules; run \`npm install\` first" >&2
  exit 1
fi

# Compile src + test in one pass with rootDir widened.
npx tsc \
  --module commonjs \
  --target ES2022 \
  --esModuleInterop \
  --strict \
  --outDir build-test \
  --rootDir . \
  src/triggers.ts src/config.ts test/triggers.test.ts test/config.test.ts

node --test build-test/test/triggers.test.js build-test/test/config.test.js
