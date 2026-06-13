#!/bin/bash
set -euo pipefail

BOLD='\033[1m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
DIM='\033[2m'
RESET='\033[0m'

# Ensure wrangler-compatible Node version (≥22) via nvm
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck source=/dev/null
[[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh"
nvm use 22 --silent

export CLOUDFLARE_ACCOUNT_ID=""
export CLOUDFLARE_API_TOKEN=""

# Fail fast if the placeholders haven't been replaced with real values
if [[ "$CLOUDFLARE_ACCOUNT_ID" == "dummy value" || "$CLOUDFLARE_API_TOKEN" == "dummy value" ]]; then
  echo -e "\033[0;31m✘ CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN are still placeholders.\033[0m"
  echo -e "  Edit the values at the top of this file before running."
  exit 1
fi

# Always run from the project root so generated files and .gtfs_* markers land there
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

read -r -p "Publish to remote? [y/N] " PUBLISH_REMOTE

echo -e "${YELLOW}▶ Step 1: Download & generate SQL${RESET}"
# Increase heap — shapes + stop_times index can approach 2 GB in diff mode
node --max-old-space-size=8192 scripts/gtfs/generate-sql.mjs

echo -e "\n${YELLOW}▶ Import breakdown:${RESET}"
# print-stats.mjs exits 0 if feed unchanged, 1 if there are changes to import
if node scripts/gtfs/print-stats.mjs; then
  echo -e "\n${GREEN}${BOLD}✔ Feed version unchanged — nothing to import.${RESET}"
  exit 0
fi

echo ""
read -r -p "Proceed with import? [y/N] " PROCEED
if [[ "$PROCEED" != "y" && "$PROCEED" != "Y" ]]; then
  echo -e "${DIM}Aborted. SQL file kept at: $(cat scripts/gtfs/artifacts/.gtfs_last_sql)${RESET}"
  exit 0
fi

echo -e "\n${YELLOW}▶ Step 2: Execute SQL against D1${RESET}"
SQL_FILE=$(cat scripts/gtfs/artifacts/.gtfs_last_sql)
REMOTE_FLAG="" # set to --remote only if user confirmed above
[[ "$PUBLISH_REMOTE" == "y" || "$PUBLISH_REMOTE" == "Y" ]] && REMOTE_FLAG="--remote"
npx wrangler d1 execute nta-static $REMOTE_FLAG --file="$SQL_FILE"

# Stamp the static data version in KV so workers invalidate their edge cache.
# Version = "<feed_uuid>/<ISO-timestamp>" — the UUID comes from feed_info.txt,
# written by generate-sql.mjs to .gtfs_feed_version after each run.
# This runs BEFORE baseline promotion: if the KV write fails (set -e aborts here),
# the baseline stays unpromoted so a re-run still detects changes and retries the
# whole publish, instead of reporting "unchanged" with a stale version key.
FEED_UUID=$(cat scripts/gtfs/artifacts/.gtfs_feed_version)
STATIC_VERSION="${FEED_UUID}/$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo -e "\n${YELLOW}▶ Writing static version to KV: ${STATIC_VERSION}${RESET}"
npx wrangler kv key put --binding=STATIC_META_KV $REMOTE_FLAG "static:version" "$STATIC_VERSION"
echo -e "${GREEN}${BOLD}  ✔ static:version = ${STATIC_VERSION}${RESET}"

# Promote the just-imported zip as the new baseline for future diffs.
# Last step on purpose — only reached after both the D1 import AND the KV stamp
# succeeded, so the baseline only advances once the publish is fully committed.
if [[ -f scripts/gtfs/artifacts/.gtfs_pending_zip ]]; then
  cp scripts/gtfs/artifacts/.gtfs_pending_zip scripts/gtfs/artifacts/.gtfs_last_zip
  echo -e "${DIM}  Baseline updated → $(cat scripts/gtfs/artifacts/.gtfs_last_zip)${RESET}"
fi

echo -e "\n${GREEN}${BOLD}✔ Done${RESET}"
