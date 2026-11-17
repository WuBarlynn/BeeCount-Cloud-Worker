#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
cd frontend
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required to build the web console (corepack enable pnpm)" >&2
  exit 1
fi
pnpm install --frozen-lockfile
cd apps/web
pnpm build
