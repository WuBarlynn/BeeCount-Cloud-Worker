#!/usr/bin/env bash
# Apply every migrations/*.sql in order. Usage: scripts/db-migrate.sh --local|--remote
set -euo pipefail
cd "$(dirname "$0")/.."
MODE="${1:---local}"
for f in migrations/*.sql; do
  echo "==> $f ($MODE)"
  npx wrangler d1 execute beecount-cloud "$MODE" --file="$f"
done
