#!/bin/bash
set -euo pipefail

BOLD='\033[1m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
DIM='\033[2m'
RESET='\033[0m'

export CLOUDFLARE_ACCOUNT_ID="your-account-id-here"
export CLOUDFLARE_API_TOKEN="your-api-token-here"

read -r -p "Publish to remote? [y/N] " PUBLISH_REMOTE

echo -e "${YELLOW}▶ Step 1: Generate SQL file${RESET}"
node scripts/generate-gtfs-sql.mjs

echo -e "\n${YELLOW}▶ Step 2: Execute SQL against D1 (this may take a while)${RESET}"
SQL_FILE=$(cat .gtfs_last_sql)
REMOTE_FLAG="" # set to --remote only if user confirmed
[[ "$PUBLISH_REMOTE" == "y" || "$PUBLISH_REMOTE" == "Y" ]] && REMOTE_FLAG="--remote"
npx wrangler d1 execute nta-static $REMOTE_FLAG --file="$SQL_FILE"

echo -e "\n${GREEN}${BOLD}✔ Done${RESET}"
