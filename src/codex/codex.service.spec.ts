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
      expect(await testService.getAccounts()).toEqual([
        expect.objectContaining({
          email: 'operator@example.com',
          status: 'pending',
        }),
      ]);
      await callbackCompletion;
      expect(testService.getStatus().state).toBe('completed');
      expect(await testService.getAccounts()).toEqual([
        expect.objectContaining({
          email: 'operator@example.com',
          status: 'authenticated',
        }),
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

  it('orchestrates saved accounts sequentially, classifies quota, and aggregates safe progress', async () => {
    const databasePath = `/tmp/codex-batch-${randomUUID()}.sqlite`;
    const quotaClient = {
      classify: jest.fn(async ({ accessToken }: { accessToken: string }) =>
        accessToken === 'b-token'
          ? 'valid'
          : accessToken === 'c-token'
            ? 'reauth-required'
            : 'indeterminate',
      ),
    };
    const batchService = new CodexService(
      { ...config, databasePath, encryptionKey: 'test-only-encryption-key' },
      quotaClient,
    );
    const closeBrowser = jest
      .spyOn(
        batchService as unknown as { closeBrowser: () => Promise<void> },
        'closeBrowser',
      )
      .mockResolvedValue();
    const closeCallbackServer = jest
      .spyOn(
        batchService as unknown as { closeCallbackServer: () => void },
        'closeCallbackServer',
      )
      .mockImplementation();
    const vault = (
      batchService as unknown as {
        accountVault: {
          upsert: (record: Record<string, string>) => Promise<unknown>;
        };
      }
    ).accountVault;
    await vault.upsert({ email: 'a@example.com', password: 'a-password' });
    await vault.upsert({
      email: 'b@example.com',
      password: 'b-password',
      accessToken: 'b-token',
    });
    await vault.upsert({
      email: 'c@example.com',
      password: 'c-password',
      accessToken: 'c-token',
    });
    await vault.upsert({
      email: 'd@example.com',
      password: 'd-password',
      accessToken: 'd-token',
    });
    const order: string[] = [];
    (
      batchService as unknown as {
        runSavedAccountFlow: (record: { email: string }) => Promise<void>;
      }
    ).runSavedAccountFlow = async ({ email }) => {
      order.push(email);
      if (email === 'c@example.com') await vault.upsert({
        email,
        password: 'c-password',
        accessToken: 'c-new-token',
      });
      if (email === 'a@example.com') throw new Error('browser failed');
    };

    try {
      await expect(batchService.startBatchFlow()).resolves.toEqual({
        total: 4,
        completed: 4,
        authenticated: 1,
        skipped: 1,
        indeterminate: 1,
        failed: 1,
        accounts: [
          {
            email: 'a@example.com',
            outcome: 'failed',
            reason: 'Codex account flow failed to start',
          },
          { email: 'b@example.com', outcome: 'skipped' },
          { email: 'c@example.com', outcome: 'authenticated' },
          {
            email: 'd@example.com',
            outcome: 'indeterminate',
            reason: 'Quota status could not be determined',
          },
        ],
      });
      expect(order).toEqual(['a@example.com', 'c@example.com']);
      expect(closeBrowser).toHaveBeenCalledTimes(2);
      expect(closeCallbackServer).toHaveBeenCalledTimes(2);
      expect(quotaClient.classify).toHaveBeenCalledTimes(3);
      expect(quotaClient.classify).toHaveBeenNthCalledWith(1, {
        accessToken: 'b-token',
      });
      expect(quotaClient.classify).toHaveBeenNthCalledWith(2, {
        accessToken: 'c-token',
      });
      expect(quotaClient.classify).toHaveBeenNthCalledWith(3, {
        accessToken: 'd-token',
      });
      expect(JSON.stringify(batchService.getStatus())).not.toContain(
        'c-password',
      );
      expect(batchService.getStatus().batch).toMatchObject({
        active: false,
        total: 4,
        completed: 4,
      });
    } finally {
      await batchService.onModuleDestroy();
    }
  });

  it('prohibits overlapping batches', async () => {
    const databasePath = `/tmp/codex-overlap-${randomUUID()}.sqlite`;
    const batchService = new CodexService({
      ...config,
      databasePath,
      encryptionKey: 'test-only-encryption-key',
    });
    const vault = (
      batchService as unknown as {
        accountVault: {
          upsert: (record: Record<string, string>) => Promise<unknown>;
        };
      }
    ).accountVault;
    await vault.upsert({ email: 'a@example.com', password: 'a-password' });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    (
      batchService as unknown as {
        runSavedAccountFlow: () => Promise<void>;
      }
    ).runSavedAccountFlow = () => blocked;
    try {
      const first = batchService.startBatchFlow();
      await expect(batchService.startBatchFlow()).rejects.toBeInstanceOf(
        BadRequestException,
      );
      release();
      await first;
    } finally {
      await batchService.onModuleDestroy();
    }
  });
  it('times out an account without an OAuth callback and continues safely', async () => {
    jest.useFakeTimers();
    const databasePath = `/tmp/codex-timeout-${randomUUID()}.sqlite`;
    const batchService = new CodexService({
      ...config,
      databasePath,
      encryptionKey: 'test-only-encryption-key',
    });
    const vault = (
      batchService as unknown as {
        accountVault: {
          upsert: (record: Record<string, string>) => Promise<unknown>;
        };
      }
    ).accountVault;
    await vault.upsert({
      email: 'timeout@example.com',
      password: 'password',
      totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    });
    (
      batchService as unknown as {
        beginAccountFlow: () => Promise<unknown>;
      }
    ).beginAccountFlow = async () => ({
      state: 'never-callback',
      authorizationUrl: 'https://auth.example.test',
      createdAt: Date.now(),
    });
    try {
      const batch = batchService.startBatchFlow();
      await jest.runAllTimersAsync();
      await expect(batch).resolves.toMatchObject({
        completed: 1,
        failed: 1,
        accounts: [
          {
            email: 'timeout@example.com',
            outcome: 'failed',
            reason: 'Codex authorization callback timed out',
          },
        ],
      });
    } finally {
      jest.useRealTimers();
      await batchService.onModuleDestroy();
    }
  });
});
