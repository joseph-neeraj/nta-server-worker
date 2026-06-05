#!/bin/bash
set -euo pipefail

BOLD='\033[1m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
DIM='\033[2m'
RESET='\033[0m'

export CLOUDFLARE_ACCOUNT_ID="your-account-id-here"
export CLOUDFLARE_API_TOKEN="your-api-token-here"

echo -e "${YELLOW}▶ Step 1: Generate SQL file${RESET}"
node scripts/generate-gtfs-sql.mjs

echo -e "\n${YELLOW}▶ Step 2: Execute SQL against D1 (this may take a while)${RESET}"
SQL_FILE=$(cat .gtfs_last_sql)
npx wrangler d1 execute nta-static --remote --file="$SQL_FILE"

echo -e "\n${GREEN}${BOLD}✔ Done${RESET}"
