# Codex Login Manager

NestJS API and React/Vite UI for Codex account login through Camoufox. The login flow uses email, password, TOTP, OAuth PKCE and a local encrypted SQLite vault.

## Requirements

- Node.js 22.5 or newer (`node:sqlite` is used).
- Camoufox browser runtime fetched with `npm run camoufox:fetch`.
- `CODEX_ENCRYPTION_KEY` set. Keep it outside the database; losing it makes stored credentials and tokens unreadable.

## Development

```bash
npm install
npm run camoufox:fetch
```

Start the API in one terminal:

```bash
CODEX_ENCRYPTION_KEY='use-a-long-random-secret' npm run start:dev
```

Start the UI in another terminal:

```bash
npm run start:frontend
```

Open `http://localhost:5173`. Set `CODEX_DATABASE_PATH` to choose the SQLite file location.

## Docker Compose

Set `CODEX_ENCRYPTION_KEY` in the environment, then run:

```bash
docker compose up --build
```

Open `http://localhost:5000`.

## API

- `POST /auth/codex/accounts`: start login with email, password and Base32 TOTP secret.
- `GET /auth/codex/status`: read flow status.
- `GET /auth/codex/accounts`: list safe account metadata.
- `DELETE /auth/codex/accounts/:connectionId`: delete a stored account.
- `GET /auth/codex/callback`: OAuth callback.

CAPTCHA, email/phone verification and unsupported security steps require manual completion. See [Codex login flow](docs/codex-oauth-flow.md).

## Checks

```bash
npm test
npm run test:e2e
npm run build
```
