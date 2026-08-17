export const CODEX_CONFIG = Symbol('CODEX_CONFIG');

export const CODEX_DEFAULTS = {
  authorizationUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  scope: 'openid profile email offline_access',
  callbackHost: 'localhost',
  callbackPort: 1455,
  callbackPath: '/auth/callback',
  createAccountUrl: 'https://auth.openai.com/create-account',
  browserEngine: 'camoufox',
  stateTtlMs: 10 * 60 * 1000,
} as const;
