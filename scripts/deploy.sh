#!/usr/bin/env bash
# One-command deploy: ensures D1 + R2 exist, applies migrations, builds the web
# console and deploys the Worker. Requires `npx wrangler login` first.
set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="${DB_NAME:-beecount-cloud}"
BUCKET="${BUCKET:-beecount-attachments}"

if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "Not logged in. Run: npx wrangler login" >&2
  exit 1
fi

DB_ID="$(npx wrangler d1 list --json 2>/dev/null | python3 -c "
import json,sys
try: rows=json.load(sys.stdin)
except Exception: rows=[]
print(next((r.get('uuid') or r.get('id') or '' for r in rows if r.get('name')=='$DB_NAME'), ''))
")"
if [ -z "$DB_ID" ]; then
  echo "==> creating D1 database $DB_NAME"
  OUT="$(npx wrangler d1 create "$DB_NAME" 2>&1)"
  echo "$OUT"
  DB_ID="$(printf '%s' "$OUT" | python3 -c "
import re,sys
m=re.search(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', sys.stdin.read())
print(m.group(0) if m else '')
")"
fi
if [ -z "$DB_ID" ]; then
  echo "Could not determine the D1 database id. Create it manually and set it in wrangler.jsonc." >&2
  exit 1
fi
echo "==> D1 $DB_NAME = $DB_ID"
if git ls-files --error-unmatch wrangler.jsonc >/dev/null 2>&1; then
  echo "注意：下面会把真实 D1 id 写进 wrangler.jsonc。公开仓库请勿提交这处改动。" >&2
fi
python3 - "$DB_ID" <<'PY'
import json,re,sys
db_id=sys.argv[1]
p='wrangler.jsonc'
s=open(p).read()
s=re.sub(r'"database_id":\s*"[^"]*"', f'"database_id": "{db_id}"', s)
open(p,'w').write(s)
PY

if ! npx wrangler r2 bucket list 2>/dev/null | grep -qw "$BUCKET"; then
  echo "==> creating R2 bucket $BUCKET"
  npx wrangler r2 bucket create "$BUCKET"
fi

echo "==> applying D1 migrations"
bash scripts/db-migrate.sh --remote

echo "==> building web console"
bash scripts/build-frontend.sh

echo "==> deploying"
npx wrangler deploy
