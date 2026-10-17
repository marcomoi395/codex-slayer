import { randomUUID } from 'node:crypto';
import { CodexService } from './codex.service';

import { BadRequestException } from '@nestjs/common';

import { CodexController } from './codex.controller';
import type { CodexService } from './codex.service';

function controllerWith(service: Partial<CodexService>): CodexController {
  return new CodexController(service as CodexService);
}

describe('CodexController batch API', () => {
  it('saves credentials without starting browser login', async () => {
    const saveAccount = jest.fn().mockResolvedValue({ saved: true });
    const startAccountFlow = jest.fn();
    const controller = controllerWith({ saveAccount, startAccountFlow });
    const credentials = {
      email: 'operator@example.com',
      password: 'secret',
      totpSecret: 'GEZDGNBVGY3TQOJQ',
    };

    await expect(controller.saveAccount(credentials)).resolves.toEqual({
      saved: true,
    });
    expect(saveAccount).toHaveBeenCalledWith(credentials);
    expect(startAccountFlow).not.toHaveBeenCalled();
  });

  it('starts a batch without waiting for its final result', () => {
    let resolveBatch!: (value: never) => void;
    const startBatchFlow = jest.fn(
      () => new Promise<never>((resolve) => (resolveBatch = resolve)),
    );
    const controller = controllerWith({
      startBatchFlow,
      getStatus: () => ({ active: false, logs: [] }),
    });

    expect(controller.startBatch()).toEqual({ started: true });
    expect(startBatchFlow).toHaveBeenCalledWith(undefined);
    resolveBatch(undefined as never);
  });

  it('handles a rejected detached batch without leaking a promise rejection', async () => {
    const startBatchFlow = jest.fn().mockRejectedValue(new Error('vault unavailable'));
    const controller = controllerWith({
      startBatchFlow,
      getStatus: () => ({ active: false, logs: [] }),
    });

    expect(controller.startBatch()).toEqual({ started: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it('rejects a batch while another run is active', () => {
    const startBatchFlow = jest.fn();
    const controller = controllerWith({
      startBatchFlow,
      getStatus: () => ({
        active: false,
        batch: {
          active: true,
          total: 1,
          completed: 0,
          authenticated: 0,
          skipped: 0,
          indeterminate: 0,
          failed: 0,
          accounts: [],
        },
        logs: [],
      }),
    });

    expect(() => controller.startBatch()).toThrow(BadRequestException);
    expect(startBatchFlow).not.toHaveBeenCalled();
  });

  it('rejects a second POST while the first vault read is pending', async () => {
    const service = new CodexService({
      clientId: 'client',
      authorizationUrl: 'https://auth.openai.com/oauth/authorize',
      tokenUrl: 'https://auth.openai.com/oauth/token',
      scope: 'openid profile email offline_access',
      callbackHost: '127.0.0.1',
      callbackPort: 0,
      callbackPath: '/auth/callback',
      stateTtlMs: 600_000,
      databasePath: `/tmp/codex-controller-overlap-${randomUUID()}.sqlite`,
      encryptionKey: 'test-only-encryption-key',
    });
    const controller = new CodexController(service);
    try {
      expect(controller.startBatch()).toEqual({ started: true });
      expect(() => controller.startBatch()).toThrow(BadRequestException);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(service.getStatus().batch?.active).toBe(false);
    } finally {
      await service.onModuleDestroy();
    }
  });
});
