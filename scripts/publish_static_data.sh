#!/bin/bash
set -euo pipefail

BOLD='\033[1m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
RESET='\033[0m'

export CLOUDFLARE_ACCOUNT_ID="your-account-id-here"
export CLOUDFLARE_API_TOKEN="your-api-token-here"

read -r -p "Publish to remote? [y/N] " PUBLISH_REMOTE

echo -e "${YELLOW}▶ Step 1: Download & generate SQL${RESET}"
# Increase heap for diff mode — shapes + stop_times index can approach 2 GB
node --max-old-space-size=8192 scripts/generate-gtfs-sql.mjs

# Check whether there were any changes at all
NO_CHANGE=$(node -e "const s=JSON.parse(require('fs').readFileSync('.gtfs_stats.json')); process.stdout.write(s.noChange?'true':'false')")
if [[ "$NO_CHANGE" == "true" ]]; then
  echo -e "\n${GREEN}${BOLD}✔ Feed version unchanged — nothing to import.${RESET}"
  exit 0
fi

# Show per-table breakdown and total statement count
echo -e "\n${YELLOW}▶ Import breakdown:${RESET}"
node -e "
const s = JSON.parse(require('fs').readFileSync('.gtfs_stats.json'));
console.log('  Mode : ' + s.mode + (s.mode === 'diff' ? '  (' + s.oldVersion + ' → ' + s.newVersion + ')' : ''));
console.log('');
let totalU = 0, totalD = 0;
for (const t of s.tables) {
  const name = t.table.padEnd(16);
  if (t.upsertRows === 0 && t.deleteRows === 0) {
    console.log('  \x1b[2m' + name + '(unchanged)\x1b[0m');
  } else {
    const parts = [];
    if (t.upsertRows > 0) parts.push('+' + t.upsertRows.toLocaleString() + ' upserts (' + Math.ceil(t.upsertRows/500) + ' stmts)');
    if (t.deleteRows > 0) parts.push('-' + t.deleteRows.toLocaleString() + ' deletes (' + Math.ceil(t.deleteRows/500) + ' stmts)');
    console.log('  \x1b[33m' + name + '\x1b[0m' + parts.join(', '));
    totalU += t.upsertRows; totalD += t.deleteRows;
  }
}
const totalStmts = s.totalUpsertStatements + s.totalDeleteStatements;
console.log('');
console.log('  Total : ' + totalU.toLocaleString() + ' upserts, ' + totalD.toLocaleString() + ' deletes → ' + totalStmts.toLocaleString() + ' SQL statements');
"

echo ""
read -r -p "Proceed with import? [y/N] " PROCEED
if [[ "$PROCEED" != "y" && "$PROCEED" != "Y" ]]; then
  echo -e "${DIM}Aborted. SQL file kept at: $(cat .gtfs_last_sql)${RESET}"
  exit 0
fi

echo -e "\n${YELLOW}▶ Step 2: Execute SQL against D1${RESET}"
SQL_FILE=$(cat .gtfs_last_sql)
REMOTE_FLAG="" # set to --remote only if user confirmed above
[[ "$PUBLISH_REMOTE" == "y" || "$PUBLISH_REMOTE" == "Y" ]] && REMOTE_FLAG="--remote"
npx wrangler d1 execute nta-static $REMOTE_FLAG --file="$SQL_FILE"

# Promote the just-imported zip as the new baseline for future diffs.
# This only runs after a successful wrangler execute (set -e ensures that).
if [[ -f .gtfs_pending_zip ]]; then
  cp .gtfs_pending_zip .gtfs_last_zip
  echo -e "${DIM}  Baseline updated → $(cat .gtfs_last_zip)${RESET}"
fi

echo -e "\n${GREEN}${BOLD}✔ Done${RESET}"
