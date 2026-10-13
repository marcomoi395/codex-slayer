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
        totpSecret: 'invalid0',
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
    const originalDateNow = Date.now;
    Date.now = () => 59_000;
    const stages = ['email'];
    let closed = false;
    let state = '';
    let callbackCompletion: Promise<unknown> | undefined;
    const filledValues: string[] = [];
    const locator = (kind: string) => ({
      waitFor() {
        const visible =
          kind === 'email'
            ? stages[0] === 'email'
            : kind === 'password'
              ? stages[0] === 'password'
              : kind === 'totp'
                ? stages[0] === 'totp'
                : stages[0] === 'consent';
        return visible
          ? Promise.resolve()
          : Promise.reject(new Error('not visible'));
      },
      fill(value: string) {
        filledValues.push(value);
        return Promise.resolve();
      },
      click() {
        if (kind === 'continue' && stages[0] === 'email')
          stages[0] = 'password';
        else if (kind === 'continue' && stages[0] === 'password')
          stages[0] = 'totp';
        else if (kind === 'continue' && stages[0] === 'totp')
          stages[0] = 'consent';
        else if (kind === 'continue' && stages[0] === 'consent') {
          callbackCompletion = testService.handleCallback(
            'authorization-code',
            state,
          );
        }
        return Promise.resolve();
      },
    });
    const page = {
      goto(url: string) {
        state = new URL(url).searchParams.get('state') ?? '';
        return Promise.resolve();
      },
      url: () => 'https://auth.openai.com/log-in',
      getByLabel: (name: RegExp) =>
        locator(
          name.test('email')
            ? 'email'
            : name.test('password')
              ? 'password'
              : 'totp',
        ),
      getByRole: (role: string, options: { name: RegExp | string }) =>
        locator(
          role === 'button' || options.name === 'Continue'
            ? 'continue'
            : 'totp',
        ),
    };
    const fakeBrowser = {
      newContext() {
        return Promise.resolve({ newPage: () => Promise.resolve(page) });
      },
      close() {
        closed = true;
        return Promise.resolve();
      },
    };
    (
      testService as unknown as { launchBrowser: () => Promise<Browser> }
    ).launchBrowser = () => Promise.resolve(fakeBrowser as unknown as Browser);
    global.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'token-never-returned',
            refresh_token: 'refresh',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    try {
      await testService.startAccountFlow({
        email: 'operator@example.com',
        password: 'password-value',
        totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      });
      await callbackCompletion;
      expect(testService.getStatus().state).toBe('completed');
      expect(await testService.getAccounts()).toEqual([
        expect.objectContaining({ email: 'operator@example.com' }),
      ]);
      expect(filledValues).toEqual(
        expect.arrayContaining([
          'operator@example.com',
          'password-value',
          '287082',
        ]),
      );
      expect(JSON.stringify(testService.getStatus())).not.toContain(
        'password-value',
      );
      expect(JSON.stringify(testService.getStatus())).not.toContain(
        'token-never-returned',
      );
    } finally {
      global.fetch = originalFetch;
      Date.now = originalDateNow;
      await testService.onModuleDestroy();
    }
    expect(closed).toBe(true);
  });
});
