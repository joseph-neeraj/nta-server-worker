#!/bin/bash
set -euo pipefail

BOLD='\033[1m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
DIM='\033[2m'
RESET='\033[0m'

export CLOUDFLARE_ACCOUNT_ID="dummy value"
export CLOUDFLARE_API_TOKEN="dummy value"

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

# Promote the just-imported zip as the new baseline for future diffs.
# This only runs after a successful wrangler execute (set -e ensures that).
if [[ -f scripts/gtfs/artifacts/.gtfs_pending_zip ]]; then
  cp scripts/gtfs/artifacts/.gtfs_pending_zip scripts/gtfs/artifacts/.gtfs_last_zip
  echo -e "${DIM}  Baseline updated → $(cat scripts/gtfs/artifacts/.gtfs_last_zip)${RESET}"
fi

echo -e "\n${GREEN}${BOLD}✔ Done${RESET}"
