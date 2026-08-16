export const SMSPOOL_CONFIG = Symbol('SMSPOOL_CONFIG');

export const SMSPOOL_DEFAULTS = {
  baseUrl: 'https://api.smspool.net',
  pollIntervalMs: 5_000,
  pollTimeoutMs: 120_000,
  country: 1,
  service: 671,
  quantity: 1,
  pricingOption: 0,
} as const;
