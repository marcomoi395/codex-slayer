# Codex account login

The app manages Codex account login through Camoufox, OAuth PKCE and a local SQLite vault. Login inputs are email, password and a Base32 TOTP secret. The generated six-digit code is transient.

## Configuration

```env
CODEX_CLIENT_ID=app_EMoamEE73f0CkXaXp7hrann
CODEX_AUTHORIZATION_URL=https://auth.openai.com/oauth/authorize
CODEX_TOKEN_URL=https://auth.openai.com/oauth/token
CODEX_QUOTA_URL=https://chatgpt.com/backend-api/wham/usage
CODEX_CALLBACK_HOST=127.0.0.1
CODEX_CALLBACK_PORT=1455
CODEX_DATABASE_PATH=/app/data/codex-accounts.sqlite
CODEX_ENCRYPTION_KEY=replace-with-a-long-random-secret
```

`CODEX_ENCRYPTION_KEY` is required in production. Passwords, TOTP secrets and OAuth tokens are encrypted at rest. Keep the key outside the database and back it up separately.

`CODEX_QUOTA_URL` configures the authenticated quota check: `GET` with `Authorization: Bearer <access token>` and optional `ChatGPT-Account-ID`. HTTP 2xx with a JSON object containing a non-empty string `plan_type` means valid; HTTP 401 means reauthentication; every other response, invalid JSON, timeout or network failure is indeterminate. This usage endpoint follows current internal Codex CLI behavior, is configurable, and is not a stable public API contract.

The non-empty `plan_type` requirement is intentional: it identifies a typed usage payload; syntactically valid but unrelated/arbitrary JSON is not evidence of a valid account.

## API

- `POST /auth/codex/accounts`: save one account with `{ "email", "password", "totpSecret" }`; credentials are encrypted at rest and no browser login starts. Response contains only `{ "saved": true }`.
- `POST /auth/codex/batch`: start a sequential batch for selected saved accounts with `{ "connectionIds": ["…"] }`. The response is immediate `{ "started": true, "runId": "…" }`; progress and the final report are read from `GET /auth/codex/status`.
- `GET /auth/codex/status`: read safe login/batch state. During and after a batch, `batch` includes stable `runId`, `startedAt`, `completedAt` when terminal, `state` (`running`, `completed`, or `failed`), `active`, `currentEmail`, totals, and safe per-account outcomes with `completedAt` and optional reasons.
- `GET /auth/codex/accounts`: list safe account summaries with `status: "pending"` or `"authenticated"`; secrets never appear.
- `DELETE /auth/codex/accounts/:connectionId`: delete an account and its stored secrets/tokens.
- `GET /auth/codex/callback`: receive and validate the OAuth callback.
- `GET /auth/codex/accounts/export`: download one plaintext `email|password|TOTP secret` row per account.
- `GET /auth/codex/accounts/credentials/export`: download authenticated account tokens as a JSON array of `{ "accessToken", "refreshToken", "idToken", "email" }` objects.
- `POST /auth/codex/accounts/import`: import `{ "content": "email|password|TOTP secret\\n…" }`; matching emails are updated. Every non-empty row must contain exactly three valid fields; malformed input is rejected before saving.

Exported files are unencrypted and expose passwords and TOTP secrets. Store and transfer them accordingly.
Token export files contain bearer credentials and are plaintext. Store and transfer them securely.

Batch startup errors are recorded in safe status logs. A second batch or login is rejected while another run is active.

The login flow keeps PKCE, validates OAuth state and its TTL, allows one active login at a time, and closes browser/callback resources after completion or failure. CAPTCHA, email verification, phone verification and unsupported login steps stop for manual handling; the app does not bypass them.
