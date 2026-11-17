#!/usr/bin/env bash
# Reset a BeeCount Cloud user's password directly in D1.
#
#   bash scripts/reset-password.sh you@example.com
#
# The new password is typed twice and never echoed, never passed in argv and
# never written to disk. Useful when the administrator password is lost:
# ADMIN_EMAIL / ADMIN_PASSWORD only apply while the users table is empty.
set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="${DB_NAME:-beecount-cloud}"
EMAIL="${1:-}"

if [ -z "$EMAIL" ]; then
  read -r -p "User email: " EMAIL
fi
[ -n "$EMAIL" ] || { echo "email is required" >&2; exit 1; }

if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "Not logged in. Run: npx wrangler login" >&2
  exit 1
fi

if [ -n "${BEE_PASSWORD:-}" ]; then
  PW1="$BEE_PASSWORD"
  PW2="$BEE_PASSWORD"
else
  read -r -s -p "New password: " PW1; echo
  read -r -s -p "Repeat password: " PW2; echo
fi
[ "$PW1" = "$PW2" ] || { echo "Passwords do not match." >&2; exit 1; }
[ "${#PW1}" -ge 8 ] || { echo "Use at least 8 characters." >&2; exit 1; }

# Same format as src/lib/crypto.ts: pbkdf2$<iterations>$<salt b64>$<hash b64>
HASH="$(printf '%s' "$PW1" | node --input-type=module -e '
let s = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) s += chunk;
const iterations = 12000;
const salt = crypto.getRandomValues(new Uint8Array(16));
const bits = await crypto.subtle.deriveBits(
  { name: "PBKDF2", hash: "SHA-256", salt, iterations },
  await crypto.subtle.importKey("raw", new TextEncoder().encode(s), "PBKDF2", false, ["deriveBits"]),
  256,
);
const b64 = (u) => Buffer.from(u).toString("base64");
process.stdout.write(`pbkdf2$${iterations}$${b64(salt)}$${b64(new Uint8Array(bits))}`);
')"

ESCAPED_EMAIL="${EMAIL//\'/\'\'}"
NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
chmod 600 "$TMP"
cat > "$TMP" <<SQL
UPDATE users
SET password_hash = '${HASH}', updated_at = '${NOW}'
WHERE email = '${ESCAPED_EMAIL}';
SELECT email, is_admin, updated_at FROM users WHERE email = '${ESCAPED_EMAIL}';
SQL

npx wrangler d1 execute "$DB_NAME" --remote --file="$TMP"
echo "Password updated for $EMAIL."
