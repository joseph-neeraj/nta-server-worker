#!/bin/bash
# Runs the shape-rename optimisation test against the sample GTFS zips.
# Uses old.zip / new.zip in this directory by default.
# Pass two zip paths as arguments to test against different feeds:
#   bash scripts/gtfs/test/run.sh <old.zip> <new.zip>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

OLD="${1:-$SCRIPT_DIR/old.zip}"
NEW="${2:-$SCRIPT_DIR/new.zip}"

node --max-old-space-size=6144 "$SCRIPT_DIR/test-optimization.mjs" "$OLD" "$NEW"
