#!/bin/bash
# Runs all GTFS script tests.
# Unit tests (lib.mjs pure functions) run first, then the optimization integration test.
# Pass two zip paths as arguments to override the integration test zips:
#   bash scripts/gtfs/test/run.sh [<old.zip> <new.zip>]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OLD="${1:-$SCRIPT_DIR/old.zip}"
NEW="${2:-$SCRIPT_DIR/new.zip}"

echo "━━━ Unit tests ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
node "$SCRIPT_DIR/test-unit.mjs"

echo ""
echo "━━━ Integration test (shape rename optimisation) ━━━━━━━━━━━━"
node --max-old-space-size=6144 "$SCRIPT_DIR/test-optimization.mjs" "$OLD" "$NEW"

