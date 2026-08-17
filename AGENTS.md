# Repository Guidelines

## Project Overview

NestJS/TypeScript API for:

- Google Gmail OAuth and OpenAI verification-code retrieval.
- SMSPool phone-number purchase, verification-code polling, and refund.
- A root health-style endpoint: `GET /` → `Hello World!`.

Primary source: `src/`. Primary command reference: `package.json`.

## Architecture & Data Flow

- `src/main.ts` bootstraps Nest with `AppModule`, listening on `process.env.PORT ?? 3000`.
- `src/app.module.ts` enables global `ConfigModule` and imports feature modules.
- Gmail flow:
  - `src/google-gmail/google-gmail.controller.ts` exposes `/auth/google/gmail/*`.
  - `GoogleGmailService` generates OAuth state/URLs, exchanges codes, calls Gmail, extracts six-digit codes.
  - OAuth state and tokens are kept in in-memory `Map` instances.
  - Callback writes a sanitized credential object to root `credential.json`.
- Phone verification flow:
  - `PhoneVerificationProvider` defines the provider contract.
  - `SmsPoolModule` binds that contract to `SmsPoolService`.
  - `SmsPoolService` calls SMSPool, normalizes response shapes, polls for codes, and refunds orders.
- Controllers stay thin; services own external I/O and business logic.

## Key Directories

- `src/` — application code.
- `src/google-gmail/` — Gmail OAuth, Gmail API access, code extraction.
- `src/phone-verification/` — provider abstraction and shared types.
- `src/phone-verification/providers/smspool/` — SMSPool implementation and HTTP endpoints.
- `test/` — end-to-end specs and Jest e2e config.
- `scripts/` — local OAuth helper scripts.
- `postman/` — Gmail API request collection.
- `docs/` — flow notes; verify paths against current source before relying on them.

## Development Commands

```bash
npm install
npm run start              # normal development
npm run start:dev          # watch mode
npm run start:debug        # debug + watch
npm run build              # Nest production build
npm run start:prod         # run dist/main
npm run lint               # ESLint with --fix
npm run format             # Prettier on src/ and test/
npm run test               # unit tests
npm run test:watch         # Jest watch mode
npm run test:cov           # coverage output in coverage/
npm run test:e2e          # e2e tests
npm run google:gmail:oauth # interactive Gmail OAuth helper
```

`npx tsc --noEmit` is the available ad-hoc typecheck; no dedicated typecheck script exists.

## Code Conventions & Common Patterns

- TypeScript, Nest modules/controllers/services, decorators, and dependency injection.
- Use `async`/`await` for external calls; use `fetch` for provider APIs.
- Inject configuration through `@nestjs/config` factories and token constants, not direct global reads inside services.
- Required configuration fails early: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, and `SMSPOOL_API_KEY`.
- Use Nest HTTP exceptions in Gmail controllers/services; SMSPool currently uses plain `Error` for provider failures.
- Normalize untrusted API payloads with small coercion helpers before use.
- Prefer feature-local types/config/constants beside the feature.
- Tests and source use single quotes and trailing commas (`.prettierrc`).
- Preserve existing names: `*.module.ts`, `*.controller.ts`, `*.service.ts`, `*.types.ts`, `*.config.ts`, `*.constants.ts`, colocated `*.spec.ts`.
- Avoid changing in-memory state or credential persistence semantics without updating tests and OAuth documentation.

## Important Files

- `package.json` — scripts, dependencies, inline Jest config.
- `package-lock.json` — primary lockfile; npm is the documented workflow. `bun.lock` also exists.
- `src/main.ts` — process entrypoint.
- `src/app.module.ts` — top-level module wiring.
- `src/google-gmail/google-gmail.controller.ts` — Gmail routes and credential persistence.
- `src/google-gmail/google-gmail.service.ts` — OAuth/Gmail logic.
- `src/phone-verification/providers/smspool/smspool.service.ts` — SMSPool client and polling.
- `.env.example` — required environment variables and defaults.
- `scripts/google-gmail-oauth.sh` — browser/callback OAuth workflow.
- `test/jest-e2e.json` — e2e Jest configuration.

## Runtime/Tooling Preferences

- Runtime: Node.js/Nest CLI. No explicit Node version is pinned in the repository.
- Package manager: use npm commands and keep `package-lock.json` authoritative; do not add or update a second lockfile unnecessarily.
- Build output: `dist/`; Nest deletes the output directory before builds (`nest-cli.json`).
- TypeScript uses `module`/`moduleResolution: nodenext`, target `ES2023`, strict null checks, and `noImplicitAny`.
- Local OAuth helper requires `curl`, `jq`, and `python3`.
- Gmail OAuth and SMSPool integrations require external network access and valid environment variables.
- `credential.json`, `.env`, `dist/`, and `coverage/` are ignored; never commit credentials or secrets.

## Testing & QA

- Unit tests: Jest + `ts-jest`, colocated under `src/**/*.spec.ts`.
- E2E tests: `test/*.e2e-spec.ts`, configured by `test/jest-e2e.json`.
- Unit setup uses Nest `TestingModule`; HTTP e2e uses `supertest`.
- External APIs are mocked with `jest.spyOn(global, 'fetch')`; clean up with `jest.restoreAllMocks()`.
- Polling tests use sequential mocks such as `mockResolvedValueOnce`.
- Coverage collects `**/*.(t|j)s` into `coverage/`; no threshold is configured.
- Before submitting changes, run the narrowest relevant Jest spec, then `npm run test`, `npm run test:e2e`, and `npm run lint` when scope warrants.

```bash
npx jest src/google-gmail/google-gmail.service.spec.ts --runInBand
npx jest src/phone-verification/providers/smspool/smspool.service.spec.ts --runInBand
```

`docs/codex-oauth-flow.md` describes a different/stale codebase in places; treat current `src/`, `README.md`, and tests as source of truth.
