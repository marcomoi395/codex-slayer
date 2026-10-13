# Repository Guidelines

## Project

NestJS/TypeScript API, frontend React/Vite. Chỉ giữ luồng Codex OAuth và account flow.

- `src/codex/` — Codex OAuth, PKCE, browser flow, token persistence.
- `src/app.module.ts` — wiring `ConfigModule` và `CodexModule`.
- `frontend/` — Codex dashboard.
- `test/` — e2e tests.
- `docs/codex-oauth-flow.md` — Codex flow.

Credential Codex lưu trong `codex-accounts.json` (ignored).

## Commands

```bash
npm install
npm run start:dev
npm run build
npm test
npm run test:e2e
npm run lint
```

`npx tsc --noEmit` dùng cho typecheck ad-hoc.

## Conventions

- TypeScript, Nest modules/controllers/services, dependency injection.
- External I/O dùng `async`/`await`.
- Config inject qua `@nestjs/config`.
- Validate input tại trust boundaries.
- Single quotes, trailing commas.
- Feature-local types/config/constants.
- Không commit `.env`, credential, `dist/`, `coverage/`.

## Testing

- Unit tests colocated dưới `src/**/*.spec.ts`.
- E2E tests dưới `test/`.
- Test behavior, boundary, errors; tránh test wiring hoặc implementation incidental.
- Chạy test liên quan trước, sau đó full test/e2e/build khi scope thay đổi.
