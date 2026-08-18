import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { readFile, writeFile } from 'node:fs/promises';

import { GoogleGmailService } from '../google-gmail/google-gmail.service';
import { chromium } from 'playwright';
import type { CodexConfig } from './codex.config';
import { CodexService } from './codex.service';

jest.mock('node:fs/promises', () => ({
  readFile: jest.fn().mockRejectedValue(Object.assign(new Error(), { code: 'ENOENT' })),
  writeFile: jest.fn(),
}));

jest.mock('playwright', () => ({
  chromium: {
    launch: jest.fn().mockResolvedValue({
      newContext: jest.fn().mockResolvedValue({
        newPage: jest.fn().mockImplementation(async () => {
          let currentUrl = 'https://auth.openai.com/create-account';
          return {
            goto: jest.fn().mockImplementation(async () => {
              currentUrl = 'https://auth.openai.com/create-account';
            }),
            url: jest.fn(() => currentUrl),
            locator: jest.fn((selector: string) => ({
              fill: jest.fn().mockResolvedValue(undefined),
              waitFor: selector.includes('phone')
                ? jest.fn().mockRejectedValue(new Error('phone prompt absent'))
                : jest.fn().mockResolvedValue(undefined),
              click: jest.fn().mockImplementation(async () => {
                if (selector === 'button[type="submit"]') {
                  currentUrl = currentUrl.endsWith('/password')
                    ? 'https://auth.openai.com/email-verification'
                    : 'https://auth.openai.com/create-account/password';
                }
              }),
              selector,
            })),
            getByRole: jest.fn((role: string, options: { name: RegExp | string; exact?: boolean }) => ({
              waitFor: jest.fn().mockResolvedValue(undefined),
              click: jest.fn().mockImplementation(async () => {
                if (role === 'button' && options.exact) {
                  currentUrl = 'https://auth.openai.com/account';
                }
              }),
              last: jest.fn((_index?: number) => ({
                waitFor: jest.fn().mockResolvedValue(undefined),
                click: jest.fn().mockResolvedValue(undefined),
              })),
              role,
              options,
            })),
          };
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
const services = new Set<CodexService>();

function createService(
  ...args: ConstructorParameters<typeof CodexService>
): CodexService {
  const service = new CodexService(...args);
  services.add(service);
  return service;
}

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

  afterEach(async () => {
    await Promise.all(
      [...services].map((service) => service.onModuleDestroy()),
    );
    services.clear();
    jest.restoreAllMocks();
  });


  it('retries Gmail code lookup when the verification email has not arrived', async () => {
    googleGmailService.getLatestOpenAiVerificationCode
      .mockRejectedValueOnce(new NotFoundException())
      .mockRejectedValueOnce(new NotFoundException())
      .mockResolvedValueOnce('654321');
    const service = createService(config, googleGmailService);

    await service.startAccountFlow({
      email: 'user@example.com',
      password: 'secret',
    });

    expect(
      googleGmailService.getLatestOpenAiVerificationCode,
    ).toHaveBeenCalledTimes(3);
  });
  it('closes the browser when Gmail lookup fails', async () => {
    googleGmailService.getLatestOpenAiVerificationCode.mockRejectedValueOnce(
      new UnauthorizedException('Gmail messages lookup failed'),
    );
    const service = createService(config, googleGmailService);

    await expect(
      service.startAccountFlow({
        email: 'user@example.com',
        password: 'secret',
      }),
    ).rejects.toThrow('Gmail messages lookup failed');

    const browser = await (chromium.launch as jest.Mock).mock.results.at(-1)!.value;
    expect(browser.close).toHaveBeenCalled();
  });

  it('resolves the Gmail connection from the account email', async () => {
    const service = createService(config, googleGmailService);
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
    const service = createService(config, googleGmailService);

    await expect(
      service.startAccountFlow({
        email: '',
        password: '',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });


  it('fills the account email and password in the browser', async () => {
    const service = createService(config, googleGmailService);

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
    expect(
      googleGmailService.getLatestOpenAiVerificationCode,
    ).toHaveBeenCalledWith('persisted-gmail-connection', expect.any(Number));
    expect(page.getByRole).toHaveBeenNthCalledWith(2, 'button', {
      name: 'Continue',
      exact: true,
    });

    await service.onModuleDestroy();
  });
  it('uses SMSPool when signup submits into add-phone', async () => {
    const phoneVerificationProvider = {
      getPhoneNumber: jest.fn().mockResolvedValue({
        phoneNumber: '15550000000',
        orderId: 'order-1',
        expiresAt: 1_786_842_831,
      }),
      getCode: jest.fn().mockResolvedValue({ code: '654321', received: true }),
      refund: jest.fn().mockResolvedValue({ refunded: true, orderId: 'order-1' }),
    };
    let currentUrl = 'https://auth.openai.com/create-account';
    const signUpLink = { waitFor: jest.fn().mockResolvedValue(undefined), click: jest.fn() };
    const emailInput = { waitFor: jest.fn().mockResolvedValue(undefined), fill: jest.fn().mockResolvedValue(undefined) };
    const passwordInput = { waitFor: jest.fn().mockResolvedValue(undefined), fill: jest.fn().mockResolvedValue(undefined) };
    const phoneInput = { waitFor: jest.fn().mockResolvedValue(undefined), fill: jest.fn().mockResolvedValue(undefined) };
    const codeInput = { waitFor: jest.fn().mockResolvedValue(undefined), fill: jest.fn().mockResolvedValue(undefined) };
    const profileInput = { waitFor: jest.fn().mockResolvedValue(undefined), fill: jest.fn().mockResolvedValue(undefined) };
    const page = {
      goto: jest.fn().mockResolvedValue(undefined),
      url: jest.fn(() => currentUrl),
      locator: jest.fn((selector: string) => {
        if (selector === 'input[type="email"]') return emailInput;
        if (selector === 'input[type="password"]') return passwordInput;
        if (selector.includes('one-time-code')) return codeInput;
        if (selector.includes('tel') || selector.includes('phone') || selector.includes('+1')) return phoneInput;
        return { waitFor: jest.fn().mockResolvedValue(undefined), click: jest.fn().mockImplementation(() => { currentUrl = 'https://auth.openai.com/add-phone'; }) };
      }),
      getByLabel: jest.fn().mockReturnValue(profileInput),
      getByPlaceholder: jest.fn().mockReturnValue(profileInput),
      getByRole: jest.fn((role: string) =>
        role === 'link'
          ? signUpLink
          : {
              click: jest.fn().mockImplementation(() => {
                currentUrl = currentUrl.includes('/add-phone')
                  ? 'https://auth.openai.com/about-you'
                  : 'https://auth.openai.com/add-phone';
              }),
              last: jest.fn().mockReturnThis(),
            },
      ),
    };
    const browser = {
      newContext: jest.fn().mockResolvedValue({ newPage: jest.fn().mockResolvedValue(page) }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const service = createService(config, googleGmailService, phoneVerificationProvider as never);
    jest.spyOn(service as never, 'launchBrowser').mockResolvedValue(browser as never);

    await (service as unknown as { openBrowser: (url: string, credentials: unknown) => Promise<void> }).openBrowser(
      'https://auth.openai.com/oauth/authorize',
      { email: 'user@example.com', password: 'secret', connectionId: 'gmail-connection' },
    );

    expect(phoneVerificationProvider.getPhoneNumber).toHaveBeenCalled();
    expect(phoneInput.fill).toHaveBeenCalledWith('5550000000');
  });

  it('keeps Camoufox opt-in through browser configuration', async () => {
    const service = createService(
      { ...config, browserEngine: 'camoufox' },
      googleGmailService,
    );
    const launchBrowser = jest
      .spyOn(service as never, 'launchBrowser')
      .mockResolvedValue({
        newContext: jest.fn().mockResolvedValue({
          newPage: jest.fn().mockResolvedValue({
            goto: jest.fn().mockResolvedValue(undefined),
            url: jest.fn().mockReturnValue('https://auth.openai.com/account'),
            locator: jest.fn().mockReturnValue({
              fill: jest.fn().mockResolvedValue(undefined),
              waitFor: jest.fn().mockRejectedValue(new Error('input absent')),
              click: jest.fn().mockResolvedValue(undefined),
            }),
            getByRole: jest.fn((role: string) =>
              role === 'link'
                ? { waitFor: jest.fn().mockRejectedValue(new Error('signup absent')) }
                : { click: jest.fn().mockResolvedValue(undefined) },
            ),
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
  it('propagates browser interaction failures and closes resources', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const signUpLink = {
      waitFor: jest.fn().mockResolvedValue(undefined),
      click: jest.fn().mockResolvedValue(undefined),
    };
    const emailInput = {
      waitFor: jest.fn().mockResolvedValue(undefined),
      fill: jest.fn().mockRejectedValue(new Error('email selector changed')),
    };
    const page = {
      goto: jest.fn().mockResolvedValue(undefined),
      locator: jest.fn().mockReturnValue(emailInput),
      getByRole: jest.fn().mockReturnValue(signUpLink),
    };
    (chromium.launch as jest.Mock).mockResolvedValueOnce({
      newContext: jest.fn().mockResolvedValue({
        newPage: jest.fn().mockResolvedValue(page),
      }),
      close,
    });

    const service = createService(config, googleGmailService);
    await expect(
      service.startAccountFlow({
        email: 'user@example.com',
        password: 'secret',
      }),
    ).rejects.toThrow('email selector changed');

    expect(close).toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('keeps callback state when token exchange fails so it can be retried', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({ access_token: 'access-token' }),
      } as unknown as Response);
    const service = createService(config, googleGmailService);
    const authorization = await service.createAuthorizationLink();

    await expect(
      service.handleCallback('authorization-code', authorization.state),
    ).rejects.toThrow('Codex token exchange failed');
    await expect(
      service.handleCallback('authorization-code', authorization.state),
    ).resolves.toMatchObject({ accessToken: 'access-token' });

    await service.onModuleDestroy();
  });

  it('keeps callback state when persistence fails so it can be retried', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ access_token: 'access-token' }),
    } as unknown as Response);
    jest.mocked(writeFile).mockRejectedValueOnce(new Error('disk full'));
    const service = createService(config, googleGmailService);
    const authorization = await service.createAuthorizationLink('user@example.com');

    await expect(
      service.handleCallback('authorization-code', authorization.state),
    ).rejects.toThrow('disk full');
    jest.mocked(writeFile).mockResolvedValue(undefined);
    await expect(
      service.handleCallback('authorization-code', authorization.state),
    ).resolves.toMatchObject({ accessToken: 'access-token' });

    await service.onModuleDestroy();
  });

  it('clears the pending flow when Playwright cannot launch', async () => {
    jest
      .spyOn(chromium, 'launch')
      .mockRejectedValueOnce(new Error('missing browser'));
    const service = createService(config, googleGmailService);

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
    const service = createService(config, googleGmailService);

    await expect(
      service.handleCallback('code', 'unknown-state'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('persists the completed Codex connection to JSON', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: jest.fn().mockResolvedValue({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
      }),
    } as unknown as Response);
    const service = createService(config, googleGmailService);
    const authorization = await service.createAuthorizationLink('user@example.com');

    await service.handleCallback('authorization-code', authorization.state);

    expect(writeFile).toHaveBeenCalledWith(
      'codex-accounts.json',
      expect.stringContaining('access-token'),
      'utf8',
    );
    fetchMock.mockRestore();
    await service.onModuleDestroy();
  });
  it('appends a four-field account record without removing existing records', async () => {
    jest.mocked(readFile).mockResolvedValueOnce(
      JSON.stringify([
        {
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          idToken: 'old-id',
          email: 'old@example.com',
        },
      ]),
    );
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: jest.fn().mockResolvedValue({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        id_token: 'new-id',
      }),
    } as unknown as Response);
    const service = createService(config, googleGmailService);
    const authorization = await service.createAuthorizationLink('new@example.com');

    await service.handleCallback('authorization-code', authorization.state);

    expect(JSON.parse(jest.mocked(writeFile).mock.calls.at(-1)![1] as string)).toEqual([
      {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: 'old-id',
        email: 'old@example.com',
      },
      {
        connectionId: expect.any(String),
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        idToken: 'new-id',
        email: 'new@example.com',
      },
    ]);
    await service.onModuleDestroy();
  });
  it('automatically enters a purchased phone and SMS code', async () => {
    const phoneVerificationProvider = {
      getPhoneNumber: jest.fn().mockResolvedValue({
        phoneNumber: '15550000000',
        orderId: 'order-1',
        expiresAt: 1_786_842_831,
      }),
      getCode: jest.fn().mockResolvedValue({ code: '654321', received: true }),
      refund: jest.fn().mockResolvedValue({ refunded: true, orderId: 'order-1' }),
    };
    const phoneInput = {
      fill: jest.fn().mockResolvedValue(undefined),
    };
    const codeInput = {
      waitFor: jest.fn().mockResolvedValue(undefined),
      fill: jest.fn().mockResolvedValue(undefined),
    };
    const profileInput = {
      waitFor: jest.fn().mockResolvedValue(undefined),
      fill: jest.fn().mockResolvedValue(undefined),
    };
    const page = {
      locator: jest.fn((selector: string) =>
        selector.includes('tel') || selector.includes('placeholder')
          ? phoneInput
          : codeInput,
      ),
      getByLabel: jest.fn().mockReturnValue(profileInput),
      getByPlaceholder: jest.fn().mockReturnValue(profileInput),
      getByRole: jest.fn().mockReturnValue({
        click: jest.fn().mockResolvedValue(undefined),
        last: jest.fn().mockReturnValue({
          click: jest.fn().mockResolvedValue(undefined),
        }),
      }),
    };
    const service = createService(
      config,
      googleGmailService,
      phoneVerificationProvider as never,
    );
    const completePhoneVerification = (
      service as unknown as {
        completePhoneVerification: (value: unknown) => Promise<void>;
      }
    ).completePhoneVerification.bind(service);
    await completePhoneVerification(page);

    expect(phoneVerificationProvider.getPhoneNumber).toHaveBeenCalled();
    expect(phoneInput.fill).toHaveBeenCalledWith('5550000000');
    expect(page.locator).toHaveBeenCalledWith(
      expect.stringContaining('input[placeholder*="+1"]'),
    );
    expect(phoneVerificationProvider.getCode).toHaveBeenCalledWith('order-1');
    expect(codeInput.fill).toHaveBeenCalledWith('654321');
    expect(phoneVerificationProvider.refund).not.toHaveBeenCalled();
  });
  it('starts phone verification directly on the add-phone route', async () => {
    const phoneVerificationProvider = {
      getPhoneNumber: jest.fn().mockResolvedValue({
        phoneNumber: '15550000000',
        orderId: 'order-1',
        expiresAt: 1_786_842_831,
      }),
      getCode: jest.fn().mockResolvedValue({ code: '654321', received: true }),
      refund: jest.fn().mockResolvedValue({ refunded: true, orderId: 'order-1' }),
    };
    const phoneInput = {
      waitFor: jest.fn().mockRejectedValue(new Error('phone selector changed')),
      fill: jest.fn().mockResolvedValue(undefined),
    };
    const codeInput = {
      waitFor: jest.fn().mockResolvedValue(undefined),
      fill: jest.fn().mockResolvedValue(undefined),
    };
    const profileInput = {
      waitFor: jest.fn().mockResolvedValue(undefined),
      fill: jest.fn().mockResolvedValue(undefined),
    };
    let currentUrl = 'https://auth.openai.com/add-phone';
    const page = {
      goto: jest.fn().mockResolvedValue(undefined),
      url: jest.fn(() => currentUrl),
      locator: jest.fn((selector: string) => {
        if (selector.includes('one-time-code')) return codeInput;
        if (selector.includes('tel') || selector.includes('phone') || selector.includes('+1')) {
          return phoneInput;
        }
        if (selector.includes('name') || selector.includes('number') || selector.includes('age')) {
          return profileInput;
        }
        return phoneInput;
      }),
      getByLabel: jest.fn().mockReturnValue(profileInput),
      getByPlaceholder: jest.fn().mockReturnValue(profileInput),
      getByRole: jest.fn((role: string) => {
        if (role === 'link') {
          return {
            waitFor: jest.fn().mockRejectedValue(new Error('sign up absent')),
          };
        }
        return {
          waitFor: jest.fn().mockResolvedValue(undefined),
          click: jest.fn().mockImplementation(() => {
            currentUrl = currentUrl.includes('/about-you')
              ? 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent'
              : 'https://auth.openai.com/about-you';
          }),
          last: jest.fn().mockReturnValue({
            click: jest.fn().mockImplementation(() => {
              currentUrl = currentUrl.includes('/about-you')
                ? 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent'
                : 'https://auth.openai.com/about-you';
            }),
          }),
        };
      }),
    };
    const browser = {
      newContext: jest.fn().mockResolvedValue({
        newPage: jest.fn().mockResolvedValue(page),
      }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const service = createService(
      config,
      googleGmailService,
      phoneVerificationProvider as never,
    );
    jest
      .spyOn(service as never, 'launchBrowser')
      .mockResolvedValue(browser as never);
    await (service as unknown as {
      openBrowser: (url: string, credentials: unknown) => Promise<void>;
    }).openBrowser('https://auth.openai.com/oauth/authorize', {
      email: 'user@example.com',
      password: 'secret',
      connectionId: 'gmail-connection',
    });


    expect(phoneVerificationProvider.getPhoneNumber).toHaveBeenCalled();
    expect(phoneInput.fill).toHaveBeenCalledWith('5550000000');
    expect(codeInput.fill).toHaveBeenCalledWith('654321');
    expect(googleGmailService.getLatestOpenAiVerificationCode).not.toHaveBeenCalled();
  });
  it('returns to phone entry after each SMSPool code timeout', async () => {
    const phoneVerificationProvider = {
      getPhoneNumber: jest.fn().mockResolvedValue({
        phoneNumber: '15550000000',
        orderId: 'order-timeout',
        expiresAt: 1_786_842_831,
      }),
      getCode: jest.fn().mockResolvedValue({ received: false }),
      refund: jest.fn().mockResolvedValue({ refunded: true }),
    };
    const phoneInput = {
      waitFor: jest.fn().mockResolvedValue(undefined),
      fill: jest.fn().mockResolvedValue(undefined),
    };
    const codeInput = {
      waitFor: jest.fn().mockResolvedValue(undefined),
      fill: jest.fn().mockResolvedValue(undefined),
    };
    const page = {
      url: jest.fn().mockReturnValue('https://auth.openai.com/add-phone'),
      goBack: jest.fn().mockResolvedValue(undefined),
      locator: jest.fn((selector: string) =>
        selector.includes('one-time-code') ? codeInput : phoneInput,
      ),
      getByRole: jest.fn().mockReturnValue({
        last: jest.fn().mockReturnValue({
          click: jest.fn().mockResolvedValue(undefined),
        }),
      }),
    };
    const service = createService(
      config,
      googleGmailService,
      phoneVerificationProvider as never,
    );
    const completePhoneVerification = (
      service as unknown as {
        completePhoneVerification: (
          value: unknown,
          credentials: unknown,
        ) => Promise<void>;
      }
    ).completePhoneVerification.bind(service);

    await expect(
      completePhoneVerification(page, { connectionId: 'gmail-connection' }),
    ).rejects.toThrow('Phone verification code was not received');
    expect(phoneVerificationProvider.refund).toHaveBeenCalledTimes(5);
    expect(page.goBack).toHaveBeenCalledTimes(5);
  });
  it('clicks Continue when the optional Codex consent route appears', async () => {
    const consentContinue = {
      waitFor: jest.fn().mockResolvedValue(undefined),
      click: jest.fn().mockResolvedValue(undefined),
    };
    const page = {
      waitForURL: jest.fn().mockResolvedValue(undefined),
      url: jest.fn().mockReturnValue(
        'https://auth.openai.com/sign-in-with-chatgpt/codex/consent',
      ),
      getByRole: jest.fn().mockReturnValue(consentContinue),
    };
    const service = createService(config, googleGmailService);
    await (service as unknown as {
      dispatchCurrentBrowserRoute: (value: unknown, credentials: unknown) => Promise<void>;
    }).dispatchCurrentBrowserRoute(page, { connectionId: 'gmail-connection' });

    expect(consentContinue.click).toHaveBeenCalled();
    expect(consentContinue.waitFor).toHaveBeenCalledWith({
      state: 'visible',
      timeout: 10_000,
    });
    expect(consentContinue.click).toHaveBeenCalled();
  });
});
