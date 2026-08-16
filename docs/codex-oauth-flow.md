# Codex OAuth Flow

This document describes the current OpenAI Codex OAuth implementation in 9Router, from selecting **Connect** in the dashboard to storing the final credentials.

## Scope

This is the 9Router dashboard flow for the `codex` provider. It is not the OpenAI Codex CLI's local credential flow.

## Provider Configuration

The Codex OAuth configuration is defined in `open-sse/providers/registry/codex.js`:

```js
clientId: "app_EMoamEEZ73f0CkXaXp7hrann"
authorizeUrl: "https://auth.openai.com/oauth/authorize"
tokenUrl: "https://auth.openai.com/oauth/token"
scope: "openid profile email offline_access"
codeChallengeMethod: "S256"
fixedPort: 1455
callbackPath: "/auth/callback"
```

Additional authorization parameters:

```text
id_token_add_organizations=true
codex_cli_simplified_flow=true
originator=codex_cli_rs
```

`src/lib/oauth/constants/oauth.js` re-exports this configuration as `CODEX_CONFIG`.

## End-to-End Flow

```text
Dashboard
  -> Provider page
  -> OAuthModal
  -> GET /api/oauth/codex/authorize
  -> Generate state + PKCE values
  -> Start localhost callback proxy on port 1455
  -> Open auth.openai.com/oauth/authorize
  -> User authenticates
  -> OpenAI redirects to localhost:1455/auth/callback
  -> Proxy receives code + state
  -> Exchange code + code_verifier at auth.openai.com/oauth/token
  -> Map returned tokens
  -> Save provider connection in the local database
  -> Dashboard reports success
```

## 1. User Selects the Codex Connection

The user opens the Codex provider page and selects the OAuth connection action.

Relevant code:

- `src/app/(dashboard)/dashboard/providers/[id]/page.js`
- `src/shared/components/OAuthModal.js`

The page renders `OAuthModal` with:

```js
provider="codex"
```

When the modal opens, its effect starts the OAuth flow automatically.

## 2. The Client Chooses the Redirect URI

`OAuthModal` uses the fixed Codex callback URI:

```text
http://localhost:1455/auth/callback
```

This must match the redirect URI expected by the authorization server and the token exchange request.

## 3. The Server Generates OAuth Data

`OAuthModal` requests:

```http
GET /api/oauth/codex/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback
```

The route is implemented in:

```text
src/app/api/oauth/[provider]/[action]/route.js
```

The route calls `generateAuthData("codex", redirectUri)` in:

```text
src/lib/oauth/providers.js
```

`generateAuthData()` creates:

- `codeVerifier`
- `codeChallenge`
- `state`
- `authUrl`

### 3.1 PKCE Values

Implemented in `src/lib/oauth/utils/pkce.js`:

```js
codeVerifier = crypto.randomBytes(32).toString("base64url")
codeChallenge = sha256(codeVerifier).toString("base64url")
state = crypto.randomBytes(32).toString("base64url")
```

The relationship is:

```text
code_challenge = BASE64URL(SHA256(code_verifier))
```

The client sends `code_challenge` to OpenAI. The original `code_verifier` remains private and is required later for token exchange.

### 3.2 Authorization URL

The Codex handler builds the URL with:

```text
response_type=code
client_id=<Codex client ID>
redirect_uri=http://localhost:1455/auth/callback
scope=openid profile email offline_access
code_challenge=<PKCE challenge>
code_challenge_method=S256
state=<random state>
id_token_add_organizations=true
codex_cli_simplified_flow=true
originator=codex_cli_rs
```

The generated URL targets:

```text
https://auth.openai.com/oauth/authorize
```

## 4. The App Starts the Local Callback Proxy

Before opening the browser, `OAuthModal` calls:

```http
GET /api/oauth/codex/start-proxy
```

It passes:

- `app_port`
- `state`
- `code_verifier`
- `redirect_uri`

The route starts the fixed-port proxy in:

```text
src/lib/oauth/utils/server.js
```

The pending session is stored in an in-memory map keyed by `state`:

```js
pendingExchanges.set(state, {
  codeVerifier,
  redirectUri,
  status: "pending",
  createdAt: Date.now(),
});
```

This is how the callback handler later retrieves the correct PKCE verifier.

## 5. The Browser Authentication Step

The dashboard opens the generated authorization URL in a popup or a new browser tab.

The user authenticates at OpenAI and approves the requested scopes.

OpenAI does not redirect back with the final access token. It redirects with a short-lived authorization code:

```text
http://localhost:1455/auth/callback?code=<one-time-code>&state=<state>
```

The callback may also contain an OAuth error instead of `code`.

## 6. The Local Callback Receives the Code

The proxy listens on `127.0.0.1:1455` and accepts:

```text
/auth/callback
/callback
```

Implementation:

```text
src/lib/oauth/utils/server.js:startCodexProxy()
```

It extracts:

```js
const code = url.searchParams.get("code");
const state = url.searchParams.get("state");
const error = url.searchParams.get("error");
```

It looks up the pending session using `state`.

If the state is unknown, there is no matching pending exchange session. If the callback contains an OAuth error or no code, the flow fails.

## 7. Authorization Code Exchange

For the server-side Codex path, the proxy calls:

```js
exchangeTokens(
  "codex",
  code,
  session.redirectUri,
  session.codeVerifier,
  state
)
```

The Codex token exchange is implemented in:

```text
src/lib/oauth/providers.js
```

It sends:

```http
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded
Accept: application/json
```

Form body:

```text
grant_type=authorization_code
client_id=<Codex client ID>
code=<authorization code>
redirect_uri=http://localhost:1455/auth/callback
code_verifier=<original PKCE verifier>
```

OpenAI validates:

- The authorization code
- The client ID
- The redirect URI
- The PKCE verifier
- The code's expiration and one-time-use status

A successful response contains token data such as:

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "id_token": "...",
  "expires_in": 3600,
  "token_type": "Bearer",
  "scope": "openid profile email offline_access"
}
```

The exact response fields are controlled by OpenAI and may change.
