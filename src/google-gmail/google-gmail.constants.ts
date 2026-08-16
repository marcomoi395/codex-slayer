export const GOOGLE_GMAIL_CONFIG = Symbol('GOOGLE_GMAIL_CONFIG');

export const GOOGLE_GMAIL_DEFAULTS = {
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scope: 'https://www.googleapis.com/auth/gmail.readonly',
  stateTtlMs: 10 * 60 * 1000,
} as const;
