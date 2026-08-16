#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"

command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

response="$(curl -fsS "$BASE_URL/auth/google/gmail/test")"
authorization_url="$(jq -er '.authorizationUrl' <<<"$response")"
expected_state="$(jq -er '.state' <<<"$response")"

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

connection_response="$(curl -fsS -G \
  --data-urlencode "code=$code" \
  --data-urlencode "state=$actual_state" \
  "$BASE_URL/auth/google/gmail/callback")"

if [[ "${GOOGLE_GMAIL_SHOW_TOKENS:-false}" == "true" ]]; then
  jq '{accessToken, refreshToken, connectionId}' <<<"$connection_response"
else
  echo "$connection_response" | jq
fi
connection_id="$(jq -er '.connectionId' <<<"$connection_response")"
printf '\nAdd to .env:\nGOOGLE_GMAIL_CONNECTION_ID=%s\n' "$connection_id"
