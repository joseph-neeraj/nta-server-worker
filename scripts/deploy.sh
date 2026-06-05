#!/bin/bash
set -euo pipefail

BOLD='\033[1m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
DIM='\033[2m'
RESET='\033[0m'

echo -e "${YELLOW}▶ Deploying nta-server-worker to Cloudflare${RESET}"

npm run deploy

echo -e "\n${GREEN}${BOLD}✔ Deployed${RESET}"
