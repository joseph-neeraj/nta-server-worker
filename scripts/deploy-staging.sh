#!/bin/bash
set -euo pipefail

BOLD='\033[1m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
RESET='\033[0m'

echo -e "${YELLOW}▶ Deploying nta-server-worker to staging${RESET}"

npm run deploy:staging

echo -e "\n${GREEN}${BOLD}✔ Deployed to staging${RESET}"
