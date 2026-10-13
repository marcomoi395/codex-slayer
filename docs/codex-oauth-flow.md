# Codex OAuth Flow

Ứng dụng chỉ giữ luồng Codex OAuth.

## Cấu hình

```env
CODEX_CLIENT_ID=app_EMoamEEZ73f0CkXaXp7hrann
CODEX_AUTHORIZATION_URL=https://auth.openai.com/oauth/authorize
CODEX_TOKEN_URL=https://auth.openai.com/oauth/token
CODEX_CALLBACK_HOST=127.0.0.1
CODEX_CALLBACK_PORT=1455
CODEX_BROWSER=camoufox
```

## Endpoint

- `GET /auth/codex/authorize`: tạo state, PKCE, callback server.
- `POST /auth/codex/accounts`: khởi chạy browser flow bằng email/password.
- `GET /auth/codex/callback`: nhận authorization code, đổi token.
- `GET /auth/codex/status`: trạng thái flow.
- `GET /auth/codex/accounts`: danh sách account đã lưu.

Token Codex lưu trong `codex-accounts.json`. Email verification, phone verification cần hoàn tất thủ công.
