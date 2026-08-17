import { UnauthorizedException } from '@nestjs/common';

import { CodexService } from './codex.service';
import type { CodexConfig } from './codex.config';

jest.mock('playwright', () => ({
  chromium: {
    launch: jest.fn().mockResolvedValue({
      newContext: jest.fn().mockResolvedValue({
        newPage: jest.fn().mockResolvedValue({
          goto: jest.fn().mockResolvedValue(undefined),
        }),
      }),
      close: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

const config: CodexConfig = {
  clientId: 'codex-client-id',
  authorizationUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  scope: 'openid profile email offline_access',
  callbackHost: '127.0.0.1',
  callbackPort: 0,
  callbackPath: '/auth/callback',
  createAccountUrl: 'https://auth.openai.com/create-account',
  stateTtlMs: 600_000,
};

describe('CodexService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });
  it('creates a PKCE authorization URL and opens the account page', async () => {
    const service = new CodexService(config);
    const authorization = await service.startAccountFlow();
    const params = new URL(authorization.authorizationUrl).searchParams;

    expect(params.get('client_id')).toBe(config.clientId);
    expect(params.get('redirect_uri')).toBe(authorization.callbackUrl);
    expect(params.get('state')).toBe(authorization.state);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(authorization.browserUrl).toBe(config.createAccountUrl);

    await service.onModuleDestroy();
  });
  it('creates a callback authorization link without launching a browser', async () => {
    const service = new CodexService(config);
    const authorization = await service.createAuthorizationLink();
    const params = new URL(authorization.authorizationUrl).searchParams;

    expect(params.get('redirect_uri')).toBe(authorization.callbackUrl);
    expect(params.get('state')).toBe(authorization.state);
    expect(authorization.browserUrl).toBe(config.createAccountUrl);

    await service.onModuleDestroy();
  });

  it('rejects callbacks with an unknown state', async () => {
    const service = new CodexService(config);

    await expect(
      service.handleCallback('code', 'unknown-state'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
