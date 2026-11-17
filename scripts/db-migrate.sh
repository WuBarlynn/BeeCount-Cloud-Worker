#!/usr/bin/env bash
# Apply pending D1 migrations through Wrangler's migration tracker.
# Usage: scripts/db-migrate.sh --local|--remote
set -euo pipefail
cd "$(dirname "$0")/.."
MODE="${1:---local}"
npx wrangler d1 migrations apply beecount-cloud "$MODE"
