#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"

command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

response="$(curl -fsS "$BASE_URL/auth/google/gmail/authorize" -D - -o /dev/null)"
authorization_url="$(sed -n 's/^location: //Ip' <<<"$response" | tr -d '\r')"
expected_state="$(python3 - "$authorization_url" <<'PY'
import sys
from urllib.parse import parse_qs, urlparse
print(parse_qs(urlparse(sys.argv[1]).query)["state"][0])
PY
)"

echo "Open this URL in your browser:"
echo "$authorization_url"

if command -v xdg-open >/dev/null; then
  xdg-open "$authorization_url" >/dev/null 2>&1 || true
elif command -v open >/dev/null; then
  open "$authorization_url" >/dev/null 2>&1 || true
fi

read -r -p "Paste the full Google redirect URL: " redirect_url

readarray -t callback_values < <(python3 - "$redirect_url" <<'PY'
import sys
from urllib.parse import parse_qs, urlparse

query = parse_qs(urlparse(sys.argv[1]).query)
print(query.get("code", [""])[0])
print(query.get("state", [""])[0])
PY
)

code="${callback_values[0]:-}"
actual_state="${callback_values[1]:-}"

if [[ -z "$code" || -z "$actual_state" ]]; then
  echo "Redirect URL missing code or state" >&2
  exit 1
fi

if [[ "$actual_state" != "$expected_state" ]]; then
  echo "OAuth state mismatch" >&2
  exit 1
fi

curl -fsS -G \
  --data-urlencode "code=$code" \
  --data-urlencode "state=$actual_state" \
  "$BASE_URL/auth/google/gmail/callback"
printf '\nCredential saved to credential.json\n'
