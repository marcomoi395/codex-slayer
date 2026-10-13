# Codex account login

The app manages Codex account login through Camoufox, OAuth PKCE and a local SQLite vault. Login inputs are email, password and a Base32 TOTP secret. The generated six-digit code is transient.

## Configuration

```env
CODEX_CLIENT_ID=app_EMoamEE73f0CkXaXp7hrann
CODEX_AUTHORIZATION_URL=https://auth.openai.com/oauth/authorize
CODEX_TOKEN_URL=https://auth.openai.com/oauth/token
CODEX_CALLBACK_HOST=127.0.0.1
CODEX_CALLBACK_PORT=1455
CODEX_DATABASE_PATH=/app/data/codex-accounts.sqlite
CODEX_ENCRYPTION_KEY=replace-with-a-long-random-secret
```

`CODEX_ENCRYPTION_KEY` is required in production. Passwords, TOTP secrets and OAuth tokens are encrypted at rest. Keep the key outside the database and back it up separately.

## API

- `POST /auth/codex/accounts`: start login with `{ "email", "password", "totpSecret" }`; response contains only `{ "started": true }`.
- `GET /auth/codex/status`: read login state and safe status messages.
- `GET /auth/codex/accounts`: list safe account summaries.
- `DELETE /auth/codex/accounts/:connectionId`: delete an account and its stored secrets/tokens.
- `GET /auth/codex/callback`: receive and validate the OAuth callback.

The login flow keeps PKCE, validates OAuth state and its TTL, allows one active login at a time, and closes browser/callback resources after completion or failure. CAPTCHA, email verification, phone verification and unsupported login steps stop for manual handling; the app does not bypass them.
