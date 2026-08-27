import { ConfigService } from '@nestjs/config';

import {
  createProtonMailConfig,
  ProtonMailModule,
} from './proton-mail.module';
import { PROTON_MAIL_DEFAULTS } from './proton-mail.constants';

describe('createProtonMailConfig', () => {
  it('converts string timing environment values to numbers', () => {
    const values: Record<string, string> = {
      PROTON_MAIL_URL: 'https://mail.proton.me',
      PROTON_MAIL_EMAIL: 'user@example.com',
      PROTON_MAIL_PROFILE_DIR: 'data/proton-profile',
      PROTON_MAIL_SENDER: 'noreply@tm.openai.com',
      PROTON_MAIL_KEYWORDS: 'verification code',
      PROTON_MAIL_POLL_INTERVAL_MS: '5000',
      PROTON_MAIL_POLL_TIMEOUT_MS: '120000',
      PROTON_MAIL_LOGIN_TIMEOUT_MS: '300000',
    };
    const configService = {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;

    const config = createProtonMailConfig(configService);

    expect(config.pollIntervalMs).toBe(5000);
    expect(config.pollTimeoutMs).toBe(120000);
    expect(config.loginTimeoutMs).toBe(300000);
    expect(typeof config.pollIntervalMs).toBe('number');
  });

  it('uses safe defaults for invalid timing values', () => {
    const configService = {
      get: jest.fn((key: string) =>
        key.endsWith('_MS') ? 'not-a-number' : undefined,
      ),
    } as unknown as ConfigService;

    const config = createProtonMailConfig(configService);

    expect(config.pollIntervalMs).toBe(PROTON_MAIL_DEFAULTS.pollIntervalMs);
    expect(config.pollTimeoutMs).toBe(PROTON_MAIL_DEFAULTS.pollTimeoutMs);
    expect(config.loginTimeoutMs).toBe(PROTON_MAIL_DEFAULTS.loginTimeoutMs);
  });

  it('keeps the Proton module available', () => {
    expect(ProtonMailModule).toBeDefined();
  });
});
