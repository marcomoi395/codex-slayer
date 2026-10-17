import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AccountVault } from './account-vault';
import { CodexService } from './codex.service';
import type { CodexConfig } from './codex.config';
import type { Browser } from 'playwright-core';

const mockCamoufox = jest.fn();

jest.mock('camoufox-js', () => ({ Camoufox: (...args: unknown[]) => mockCamoufox(...args) }));


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

  it('reports safe account reasons and releases the flow for a later run', async () => {
    const databasePath = `/tmp/codex-batch-${randomUUID()}.sqlite`;
    const vault = new AccountVault(databasePath, 'test-only-encryption-key');
    await vault.upsert({
      email: 'safe@example.com',
      password: 'secret-password',
      accessToken: 'safe-access-token',
    });
    const batchService = new CodexService(
      { ...config, databasePath, encryptionKey: 'test-only-encryption-key' },
      { classify: async () => 'indeterminate' },
    );
    try {
      const result = await batchService.startBatchFlow();
      expect(result.accounts).toEqual([
        expect.objectContaining({
          email: 'safe@example.com',
          outcome: 'indeterminate',
          reason: 'Quota status could not be determined',
        }),
      ]);
      expect(JSON.stringify(batchService.getStatus())).not.toContain(
        'secret-password',
      );
      await expect(batchService.startBatchFlow()).resolves.toMatchObject({
        total: 1,
        completed: 1,
      });
    } finally {
      await batchService.onModuleDestroy();
      vault.close();
    }
  });

  it('keeps one run identity from live progress through its final result', async () => {
    const databasePath = `/tmp/codex-batch-metadata-${randomUUID()}.sqlite`;
    const vault = new AccountVault(databasePath, 'test-only-encryption-key');
    await vault.upsert({
      email: 'run@example.com',
      password: 'password',
      accessToken: 'run-token',
    });
    let finishClassification!: (result: 'valid') => void;
    let markClassificationStarted!: () => void;
    const classificationStarted = new Promise<void>((resolve) => {
      markClassificationStarted = resolve;
    });
    const batchService = new CodexService(
      { ...config, databasePath, encryptionKey: 'test-only-encryption-key' },
      {
        classify: () => {
          markClassificationStarted();
          return new Promise<'valid'>((resolve) => {
            finishClassification = resolve;
          });
        },
      },
    );
    try {
      const completion = batchService.startBatchFlow();
      await classificationStarted;
      const progress = batchService.getStatus().batch!;
      expect(progress.active).toBe(true);
      expect(progress.currentEmail).toBe('run@example.com');
      expect(progress.runId).toEqual(expect.any(String));
      expect(progress.startedAt).toEqual(expect.any(Number));
      expect(progress.state).toBe('running');
      finishClassification('valid');

      const result = await completion;
      expect(result).toMatchObject({
        runId: progress.runId,
        startedAt: progress.startedAt,
        state: 'completed',
        total: 1,
        completed: 1,
      });
      expect(result.completedAt).toEqual(expect.any(Number));
      expect(result.completedAt).toBeGreaterThanOrEqual(result.startedAt);
      expect(result.accounts[0]).toMatchObject({
        email: 'run@example.com',
        outcome: 'skipped',
      });
      expect(result.accounts[0].completedAt).toEqual(expect.any(Number));
      expect(batchService.getStatus().batch).toMatchObject({
        runId: result.runId,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        state: 'completed',
        active: false,
      });
    } finally {
      await batchService.onModuleDestroy();
      vault.close();
    }
  });

  it('keeps prior tokens when saving credentials for a reauthentication', async () => {
    const databasePath = `/tmp/codex-retained-token-${randomUUID()}.sqlite`;
    const vault = new AccountVault(databasePath, 'test-only-encryption-key');
    await vault.upsert({
      email: 'reauth@example.com',
      password: 'old-password',
      accessToken: 'old-access-token',
      refreshToken: 'old-refresh-token',
      idToken: 'old-id-token',
    });
    const classify = jest.fn(async () => 'valid' as const);
    const batchService = new CodexService(
      { ...config, databasePath, encryptionKey: 'test-only-encryption-key' },
      { classify },
    );
    try {
      await batchService.saveAccount({
        email: 'reauth@example.com',
        password: 'new-password',
        totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      });
      await expect(batchService.startBatchFlow()).resolves.toMatchObject({
        skipped: 1,
      });
      expect(classify).toHaveBeenCalledWith({
        accessToken: 'old-access-token',
      });
    } finally {
      await batchService.onModuleDestroy();
      vault.close();
    }
  });

  it('rejects concurrent starts while the initial account list is loading', async () => {
    const databasePath = `/tmp/codex-overlap-${randomUUID()}.sqlite`;
    const vault = new AccountVault(databasePath, 'test-only-encryption-key');
    await vault.upsert({
      email: 'a@example.com',
      password: 'a-password',
      accessToken: 'a-token',
    });
    const batchService = new CodexService(
      { ...config, databasePath, encryptionKey: 'test-only-encryption-key' },
      { classify: async () => 'valid' },
    );
    try {
      const first = batchService.startBatchFlow();
      await expect(batchService.startBatchFlow()).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(first).resolves.toMatchObject({ total: 1, completed: 1 });
    } finally {
      await batchService.onModuleDestroy();
      vault.close();
    }
  });
  it('continues after a browser launch failure and closes the next account browser', async () => {
    const databasePath = `/tmp/codex-browser-continuation-${randomUUID()}.sqlite`;
    const vault = new AccountVault(databasePath, 'test-only-encryption-key');
    for (const email of ['a@example.com', 'b@example.com']) {
      await vault.upsert({
        email,
        password: 'password',
        totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      });
    }
    let batchService: CodexService;
    let launches = 0;
    let browserClosed = false;
    let state = '';
    let callbackCompletion: Promise<unknown> | undefined;
    mockCamoufox.mockImplementation(async () => {
      launches += 1;
      if (launches === 1) throw new Error('browser launch failed');
      const stages = ['email'];
      const locator = (kind: string) => ({
        waitFor: () => Promise.resolve(),
        fill: () => Promise.resolve(),
        click: () => {
          if (kind === 'continue' && stages[0] === 'email') stages[0] = 'password';
          else if (kind === 'continue' && stages[0] === 'password') stages[0] = 'totp';
          else if (kind === 'continue' && stages[0] === 'totp') stages[0] = 'consent';
          else if (kind === 'continue' && stages[0] === 'consent') {
            callbackCompletion = batchService.handleCallback('authorization-code', state);
          }
          return Promise.resolve();
        },
      });
      const page = {
        goto: (url: string) => {
          state = new URL(url).searchParams.get('state') ?? '';
          return Promise.resolve();
        },
        url: () => 'https://auth.openai.com/log-in',
        getByLabel: (name: RegExp) =>
          locator(name.test('email') ? 'email' : name.test('password') ? 'password' : 'totp'),
        getByRole: (_role: string, options: { name: RegExp | string }) =>
          locator(options.name === 'Continue' || options.name instanceof RegExp ? 'continue' : 'totp'),
      };
      return {
        newContext: async () => ({ newPage: async () => page }),
        close: async () => { browserClosed = true; },
      };
    });
    batchService = new CodexService(
      {
        ...config,
        databasePath,
        encryptionKey: 'test-only-encryption-key',
      },
      undefined,
      async () => (await mockCamoufox()) as Browser,
    );
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    try {
      const result = await batchService.startBatchFlow();
      await callbackCompletion;
      expect(result.accounts).toEqual([
        expect.objectContaining({ email: 'a@example.com', outcome: 'failed' }),
        expect.objectContaining({ email: 'b@example.com', outcome: 'authenticated' }),
      ]);
      expect(launches).toBe(2);
      expect(browserClosed).toBe(true);
      expect(await vault.get((await vault.list())[1].connectionId)).toEqual(
        expect.objectContaining({ email: 'b@example.com', accessToken: 'new-access-token' }),
      );
    } finally {
      mockCamoufox.mockReset();
      global.fetch = originalFetch;
      await batchService.onModuleDestroy();
      vault.close();
    }
  });
});
