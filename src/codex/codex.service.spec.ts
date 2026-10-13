import { BadRequestException } from '@nestjs/common';
import { CodexService } from './codex.service';
import type { CodexConfig } from './codex.config';

const config: CodexConfig = {
  clientId: 'codex-client-id',
  authorizationUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  scope: 'openid profile email offline_access',
  callbackHost: '127.0.0.1',
  callbackPort: 0,
  callbackPath: '/auth/callback',
  createAccountUrl: 'https://auth.openai.com/create-account',
  browserEngine: 'camoufox',
  accountsFile: 'codex-accounts.json',
  stateTtlMs: 600_000,
};

describe('CodexService', () => {
  let service: CodexService;

  beforeEach(() => {
    service = new CodexService(config);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('creates a PKCE authorization URL', async () => {
    const authorization = await service.createAuthorizationLink();
    const url = new URL(authorization.authorizationUrl);

    expect(url.origin).toBe('https://auth.openai.com');
    expect(url.searchParams.get('client_id')).toBe(config.clientId);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(authorization.state);
  });

  it('rejects incomplete account credentials', async () => {
    await expect(
      service.startAccountFlow({ email: '', password: '' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
