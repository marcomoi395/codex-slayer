import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Browser } from 'playwright-core';
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

  it('rejects malformed TOTP secrets before browser launch', async () => {
    await expect(
      service.startAccountFlow({
        email: 'operator@example.com',
        password: 'not-returned',
        totpSecret: 'invalid',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.getStatus()).toEqual({ active: false, logs: [] });
  });

  it('completes the credential and callback flow through a fake browser', async () => {
    const databasePath = `/tmp/codex-service-${randomUUID()}.sqlite`;
    const testService = new CodexService({
      ...config,
      databasePath,
      encryptionKey: 'test-only-encryption-key',
    });
    const originalFetch = global.fetch;
    const stages = ['email'];
    let closed = false;
    let state = '';
    const filledValues: string[] = [];
    const locator = (kind: string) => ({
      async waitFor() {
        const visible =
          kind === 'email' ? stages[0] === 'email' :
          kind === 'password' ? stages[0] === 'password' :
          kind === 'totp' ? stages[0] === 'totp' : stages[0] === 'consent';
        if (!visible) throw new Error('not visible');
      },
      async fill(value: string) {
        filledValues.push(value);
      },
      async click() {
        if (kind === 'continue' && stages[0] === 'email') stages[0] = 'password';
        else if (kind === 'continue' && stages[0] === 'password') stages[0] = 'totp';
        else if (kind === 'continue' && stages[0] === 'totp') stages[0] = 'consent';
        else if (kind === 'continue' && stages[0] === 'consent') {
          void testService.handleCallback('authorization-code', state);
        }
      },
    });
    const page = {
      async goto(url: string) {
        state = new URL(url).searchParams.get('state') ?? '';
      },
      url: () => 'https://auth.openai.com/sign-in',
      getByLabel: (name: RegExp) =>
        locator(name.test('email') ? 'email' : name.test('password') ? 'password' : 'totp'),
      getByRole: (role: string, options: { name: RegExp | string }) =>
        locator(role === 'button' || options.name === 'Continue' ? 'continue' : 'totp'),
    };
    const fakeBrowser = {
      async newContext() {
        return { newPage: async () => page };
      },
      async close() {
        closed = true;
      },
    };
    (testService as unknown as { launchBrowser: () => Promise<Browser> }).launchBrowser =
      async () => fakeBrowser as unknown as Browser;
    global.fetch = async () =>
      new Response(
        JSON.stringify({ access_token: 'token-never-returned', refresh_token: 'refresh' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    try {
      await testService.startAccountFlow({
        email: 'operator@example.com',
        password: 'password-value',
        totpSecret: 'JBSWY3DPEHPK3PXP',
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(testService.getStatus().state).toBe('completed');
      expect(await testService.getAccounts()).toEqual([
        expect.objectContaining({ email: 'operator@example.com' }),
      ]);
      expect(filledValues).toEqual(
        expect.arrayContaining(['operator@example.com', 'password-value']),
      );
      expect(JSON.stringify(testService.getStatus())).not.toContain('password-value');
      expect(JSON.stringify(testService.getStatus())).not.toContain('token-never-returned');
    } finally {
      global.fetch = originalFetch;
      await testService.onModuleDestroy();
    }
    expect(closed).toBe(true);
  });
});
