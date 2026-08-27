export const PROTON_MAIL_CONFIG = Symbol('PROTON_MAIL_CONFIG');

export const PROTON_MAIL_DEFAULTS = {
  url: 'https://mail.proton.me',
  profileDir: 'data/proton-profile',
  sender: 'noreply@tm.openai.com',
  pollIntervalMs: 5_000,
  pollTimeoutMs: 120_000,
  loginTimeoutMs: 300_000,
} as const;
