#!/bin/bash
set -euo pipefail

BOLD='\033[1m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
DIM='\033[2m'
RESET='\033[0m'

echo -e "${YELLOW}▶ Generating TypeScript types from gtfs-realtime.proto${RESET}"
echo -e "${DIM}  output → src/generated/res/gtfs-realtime.ts${RESET}"

npm run proto

echo -e "\n${GREEN}${BOLD}✔ Done${RESET}"
