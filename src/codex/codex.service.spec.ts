import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { GoogleGmailService } from '../google-gmail/google-gmail.service';
import { chromium } from 'playwright';
import type { CodexConfig } from './codex.config';
import { CodexService } from './codex.service';

jest.mock('playwright', () => ({
  chromium: {
    launch: jest.fn().mockResolvedValue({
      newContext: jest.fn().mockResolvedValue({
        newPage: jest.fn().mockResolvedValue({
          goto: jest.fn().mockResolvedValue(undefined),
          locator: jest.fn((selector: string) => ({
            fill: jest.fn().mockResolvedValue(undefined),
            waitFor: jest.fn().mockResolvedValue(undefined),
            click: jest.fn().mockResolvedValue(undefined),
            selector,
          })),
          getByRole: jest.fn().mockReturnValue({
            waitFor: jest.fn().mockResolvedValue(undefined),
            click: jest.fn().mockResolvedValue(undefined),
          }),
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
  browserEngine: 'playwright',
  stateTtlMs: 600_000,
};
describe('CodexService', () => {
  const googleGmailService = {
    getCredentialConnectionId: jest
      .fn()
      .mockResolvedValue('persisted-gmail-connection'),
    getLatestOpenAiVerificationCode: jest
      .fn()
      .mockResolvedValue('123456'),
  } as unknown as GoogleGmailService & {
    getLatestOpenAiVerificationCode: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    googleGmailService.getLatestOpenAiVerificationCode.mockResolvedValue(
      '123456',
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('retries Gmail code lookup when the verification email has not arrived', async () => {
    googleGmailService.getLatestOpenAiVerificationCode
      .mockRejectedValueOnce(new NotFoundException())
      .mockRejectedValueOnce(new NotFoundException())
      .mockResolvedValueOnce('654321');
    const service = new CodexService(config, googleGmailService);

    await service.startAccountFlow({
      email: 'user@example.com',
      password: 'secret',
    });

    expect(
      googleGmailService.getLatestOpenAiVerificationCode,
    ).toHaveBeenCalledTimes(3);
  });

  it('resolves the Gmail connection from the account email', async () => {
    const service = new CodexService(config, googleGmailService);
    const authorization = await service.startAccountFlow({
      email: 'user@example.com',
      password: 'secret',
    });

    expect(googleGmailService.getCredentialConnectionId).toHaveBeenCalledWith(
      'user@example.com',
    );
    expect(authorization.browserUrl).toBe(config.createAccountUrl);
    await service.onModuleDestroy();
  });

  it('rejects missing account credentials', async () => {
    const service = new CodexService(config, googleGmailService);

    await expect(
      service.startAccountFlow({
        email: '',
        password: '',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });


  it('fills the account email and password in the browser', async () => {
    const service = new CodexService(config, googleGmailService);

    await service.startAccountFlow({
      email: 'user@example.com',
      password: 'secret',
    });

    const browser = await (chromium.launch as jest.Mock).mock.results.at(-1)!.value;
    const context = await browser.newContext.mock.results.at(-1)!.value;
    const page = await context.newPage.mock.results.at(-1)!.value;
    expect(page.getByRole).toHaveBeenCalledWith('link', {
      name: /sign up/i,
    });
    expect(page.locator).toHaveBeenNthCalledWith(1, 'input[type="email"]');
    expect(page.locator.mock.results[0].value.waitFor).toHaveBeenCalledWith({
      state: 'visible',
      timeout: 10_000,
    });
    expect(page.locator.mock.results[0].value.fill).toHaveBeenCalledWith(
      'user@example.com',
    );
    expect(page.locator).toHaveBeenNthCalledWith(2, 'button[type="submit"]');
    expect(page.locator.mock.results[1].value.waitFor).toHaveBeenCalledWith({
      state: 'visible',
      timeout: 10_000,
    });
    expect(page.locator.mock.results[1].value.click).toHaveBeenCalled();
    expect(page.locator).toHaveBeenNthCalledWith(3, 'input[type="password"]');
    expect(page.locator.mock.results[2].value.waitFor).toHaveBeenCalledWith({
      state: 'visible',
      timeout: 10_000,
    });
    expect(page.locator.mock.results[2].value.fill).toHaveBeenCalledWith(
      'secret',
    );
    expect(page.locator.mock.results[1].value.click).toHaveBeenCalledTimes(2);
    expect(page.locator).toHaveBeenNthCalledWith(
      4,
      'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name*="code" i], input[id*="code" i]',
    );
    expect(page.locator.mock.results[3].value.waitFor).toHaveBeenCalledWith({
      state: 'visible',
      timeout: 30_000,
    });
    expect(page.locator.mock.results[3].value.fill).toHaveBeenCalledWith(
      '123456',
    );
    expect(page.locator).toHaveBeenNthCalledWith(5, 'button[type="submit"]');
    expect(page.locator.mock.results[4].value.click).toHaveBeenCalled();
    expect(
      googleGmailService.getLatestOpenAiVerificationCode,
    ).toHaveBeenCalledWith('persisted-gmail-connection', expect.any(Number));

    await service.onModuleDestroy();
  });
  it('keeps Camoufox opt-in through browser configuration', async () => {
    const service = new CodexService(
      { ...config, browserEngine: 'camoufox' },
      googleGmailService,
    );
    const launchBrowser = jest
      .spyOn(service as never, 'launchBrowser')
      .mockResolvedValue({
        newContext: jest.fn().mockResolvedValue({
          newPage: jest.fn().mockResolvedValue({
            goto: jest.fn().mockResolvedValue(undefined),
            locator: jest.fn().mockReturnValue({
              fill: jest.fn().mockResolvedValue(undefined),
              waitFor: jest.fn().mockResolvedValue(undefined),
              click: jest.fn().mockResolvedValue(undefined),
            }),
          }),
        }),
        close: jest.fn().mockResolvedValue(undefined),
      } as never);

    await service.startAccountFlow({
      email: 'user@example.com',
      password: 'secret',
    });

    expect(launchBrowser).toHaveBeenCalled();
    await service.onModuleDestroy();
  });
  it('keeps the browser open when form interaction fails', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const page = {
      goto: jest.fn().mockResolvedValue(undefined),
      locator: jest.fn().mockReturnValue({
        fill: jest.fn().mockRejectedValue(new Error('email selector changed')),
      }),
      getByRole: jest.fn(),
    };
    (chromium.launch as jest.Mock).mockResolvedValueOnce({
      newContext: jest.fn().mockResolvedValue({
        newPage: jest.fn().mockResolvedValue(page),
      }),
      close,
    });

    const service = new CodexService(config, googleGmailService);
    await service.startAccountFlow({
      email: 'user@example.com',
      password: 'secret',
    });

    expect(close).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });
  it('creates a callback authorization link without launching a browser', async () => {
    const service = new CodexService(config, googleGmailService);
    const authorization = await service.createAuthorizationLink();
    const params = new URL(authorization.authorizationUrl).searchParams;

    expect(params.get('redirect_uri')).toBe(authorization.callbackUrl);
    expect(params.get('state')).toBe(authorization.state);
    expect(authorization.browserUrl).toBe(config.createAccountUrl);

    await service.onModuleDestroy();
  });

  it('clears the pending flow when Playwright cannot launch', async () => {
    jest
      .spyOn(chromium, 'launch')
      .mockRejectedValueOnce(new Error('missing browser'));
    const service = new CodexService(config, googleGmailService);

    await expect(
      service.startAccountFlow({
        email: 'user@example.com',
        password: 'secret',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.createAuthorizationLink()).resolves.toMatchObject({
      callbackUrl: 'http://127.0.0.1:0/auth/callback',
    });

    await service.onModuleDestroy();
  });

  it('rejects callbacks with an unknown state', async () => {
    const service = new CodexService(config, googleGmailService);

    await expect(
      service.handleCallback('code', 'unknown-state'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
