import { setImmediate } from 'node:timers/promises';

import {
  ServiceUnavailableException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import type { ProtonMailConfig } from './proton-mail.config';
import { ProtonMailService } from './proton-mail.service';
import type { ProtonMailBrowser, ProtonMailPage } from './proton-mail.types';

const config: ProtonMailConfig = {
  url: 'https://mail.proton.me',
  email: 'user@example.com',
  profileDir: 'data/proton-profile',
  sender: 'noreply@tm.openai.com',
  keywords: ['verification code'],
  pollIntervalMs: 1,
  pollTimeoutMs: 10,
  loginTimeoutMs: 10,
};

function createBrowser() {
  const body = {
    innerText: jest
      .fn()
      .mockResolvedValue(
        'From: noreply@tm.openai.com\nYour verification code is 123456',
      ),
  };
  const page: ProtonMailPage = {
    goto: jest.fn().mockResolvedValue(undefined),
    reload: jest.fn().mockResolvedValue(undefined),
    url: jest.fn().mockReturnValue('https://mail.proton.me/u/0/inbox'),
    isClosed: jest.fn().mockReturnValue(false),
    locator: jest.fn().mockReturnValue({
      count: jest.fn().mockResolvedValue(1),
      innerText: jest
        .fn()
        .mockResolvedValue(
          'From: noreply@tm.openai.com\nYour verification code is 123456',
        ),
      nth: jest.fn().mockReturnValue({
        click: jest.fn().mockResolvedValue(undefined),
        innerText: jest.fn().mockResolvedValue('OpenAI verification code'),
      }),
    }),
    waitForTimeout: jest.fn().mockResolvedValue(undefined),
    evaluate: jest.fn().mockResolvedValue(body.innerText()),
  };
  const close = jest.fn().mockResolvedValue(undefined);
  const browser: ProtonMailBrowser = {
    newPage: jest.fn().mockResolvedValue(page),
    pages: jest.fn().mockReturnValue([]),
    close,
  };
  return { browser, page, close };
}

describe('ProtonMailService', () => {
  it('returns the newest matching six-digit code and closes the browser', async () => {
    const { browser, close } = createBrowser();
    const service = new ProtonMailService(config);
    jest
      .spyOn(service as never, 'launchBrowser')
      .mockResolvedValue(browser as never);

    await expect(
      service.getLatestOpenAiVerificationCode('proton:user@example.com'),
    ).resolves.toBe('123456');
    expect(close).toHaveBeenCalled();
  });

  it('rejects an unknown connection without opening a browser', async () => {
    const service = new ProtonMailService(config);
    const launchBrowser = jest.spyOn(service as never, 'launchBrowser');

    await expect(
      service.getLatestOpenAiVerificationCode('proton:other@example.com'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it('returns not found when no matching message exists', async () => {
    const { browser, page, close } = createBrowser();
    page.locator = jest.fn().mockReturnValue({
      count: jest.fn().mockResolvedValue(0),
      innerText: jest.fn().mockResolvedValue(''),
      nth: jest.fn(),
    });
    const service = new ProtonMailService(config);
    jest
      .spyOn(service as never, 'launchBrowser')
      .mockResolvedValue(browser as never);

    await expect(
      service.getLatestOpenAiVerificationCode('proton:user@example.com'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(close).toHaveBeenCalled();
  });
  it('filters matching conversations by their API Time field', async () => {
    const service = new ProtonMailService(config);
    const response = {
      url: () => 'https://mail.proton.me/api/mail/v4/conversations',
      text: jest.fn().mockResolvedValue(
        JSON.stringify({
          Conversations: [
            {
              ID: 'older',
              Time: 1_700_000_000,
              Subject: 'Your temporary ChatGPT login code',
              Senders: [{ Address: 'noreply@tm.openai.com' }],
            },
            {
              ID: 'newer',
              Time: 1_700_000_001,
              Subject: 'Your temporary ChatGPT login code',
              Senders: [{ Address: 'noreply@tm.openai.com' }],
            },
          ],
        }),
      ),
    };
    const page = {
      on: jest.fn((_event: string, listener: (value: typeof response) => void) =>
        listener(response),
      ),
      off: jest.fn(),
    };

    await expect(
      service['captureConversationsResponse'](page as never, 1_700_000_001),
    ).resolves.toEqual([
      expect.objectContaining({ ID: 'newer', Time: 1_700_000_001 }),
    ]);
  });

  it('keeps the manual login browser open until explicit completion', async () => {
    const { browser, page, close } = createBrowser();
    browser.pages = jest.fn().mockReturnValue([page]);
    const service = new ProtonMailService(config);
    jest
      .spyOn(service as never, 'launchBrowser')
      .mockResolvedValue(browser as never);

    expect(service.startManualLogin()).toEqual({ status: 'login_started' });
    await setImmediate();
    await setImmediate();

    expect(page.goto).toHaveBeenCalledWith(config.url);
    expect(close).not.toHaveBeenCalled();

    await expect(service.completeManualLogin()).resolves.toEqual({
      status: 'login_completed',
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects completion when no manual login browser is active', async () => {
    const service = new ProtonMailService(config);

    await expect(service.completeManualLogin()).rejects.toThrow(
      'No Proton Mail login session is active',
    );
  });

  it('reuses the existing Camoufox page instead of opening a second tab', async () => {
    const { browser, page } = createBrowser();
    browser.pages = jest.fn().mockReturnValue([page]);
    const service = new ProtonMailService(config);
    jest
      .spyOn(service as never, 'launchBrowser')
      .mockResolvedValue(browser as never);

    await service['getBrowserPage'](browser);

    expect(browser.newPage).not.toHaveBeenCalled();
  });

  it('maps unexpected verification failures to service unavailable', async () => {
    const { browser, page, close } = createBrowser();
    (page.goto as jest.Mock).mockRejectedValue(new Error('browser navigation failed'))
    const service = new ProtonMailService(config);
    jest
      .spyOn(service as never, 'launchBrowser')
      .mockResolvedValue(browser as never);

    await expect(
      service.getLatestOpenAiVerificationCode('proton:user@example.com'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(close).toHaveBeenCalled();
  });

  it('reports the navigation stage for browser navigation failures', async () => {
    const { browser, page, close } = createBrowser();
    (page.goto as jest.Mock).mockRejectedValue(new Error('navigation failed'))
    const service = new ProtonMailService(config);
    jest
      .spyOn(service as never, 'launchBrowser')
      .mockResolvedValue(browser as never);

    await expect(
      service.getLatestOpenAiVerificationCode('proton:user@example.com'),
    ).rejects.toThrow(
      'Proton Mail verification lookup failed during navigation',
    );
    expect(close).toHaveBeenCalled();
  });

  it('searches historical Proton messages by configured sender', async () => {
    const { browser, page } = createBrowser();
    const searchInput = {
      count: jest.fn().mockResolvedValue(1),
      fill: jest.fn().mockResolvedValue(undefined),
      press: jest.fn().mockResolvedValue(undefined),
      innerText: jest.fn(),
      nth: jest.fn(),
    };
    page.locator = jest.fn((selector: string) =>
      selector === 'input[type="search"]' ? searchInput : createBrowser().page.locator('body'),
    ) as never;
    const service = new ProtonMailService(config);

    await service['searchMailbox'](page);

    expect(browser).toBeDefined();
  });

  it('returns an authentication error when Proton closes the page', async () => {
    const { browser, page, close } = createBrowser();
    page.isClosed = jest.fn().mockReturnValue(true);
    const service = new ProtonMailService(config);
    jest
      .spyOn(service as never, 'launchBrowser')
      .mockResolvedValue(browser as never);

    await expect(
      service.getLatestOpenAiVerificationCode('proton:user@example.com'),
    ).rejects.toThrow('Proton Mail session was closed; please log in again');
    expect(close).toHaveBeenCalled();
  });

  it('opens the newest rendered mail row and reads its detail body', async () => {
    const { browser, page } = createBrowser();
    const rowClick = jest.fn().mockResolvedValue(undefined);
    const rowLocator = {
      count: jest.fn().mockResolvedValue(1),
      nth: jest.fn().mockReturnValue({ click: rowClick }),
      innerText: jest.fn(),
    };
    page.locator = jest.fn((selector: string) =>
      selector === 'a[href*="/message/"]'
        ? rowLocator
        : {
            count: jest.fn().mockResolvedValue(0),
            nth: jest.fn(),
            innerText: jest.fn().mockResolvedValue(
              'From: noreply@tm.openai.com\nverification code 123456',
            ),
          },
    ) as never;
    const service = new ProtonMailService(config);

    const body = await service['openNewestMailAndReadBody'](page);

    expect(rowClick).toHaveBeenCalled();
    expect(body).toContain('123456');
    expect(browser).toBeDefined();
  });
  it('selects the newest rendered row matching the configured sender and keyword', async () => {
    const { page } = createBrowser();
    const firstRowLocator = jest.fn((selector: string) => ({
      count: jest.fn().mockResolvedValue(1),
      getAttribute: jest.fn().mockResolvedValue(
        selector.includes('sender') ? 'other@example.com' : 'Unrelated notice',
      ),
      innerText: jest.fn().mockResolvedValue(
        selector.includes('sender') ? 'Other sender' : 'Unrelated notice',
      ),
    }));
    const matchingRowLocator = jest.fn((selector: string) => ({
      count: jest.fn().mockResolvedValue(1),
      getAttribute: jest.fn().mockResolvedValue(
        selector.includes('sender')
          ? 'noreply@tm.openai.com'
          : 'Your temporary ChatGPT login code',
      ),
      innerText: jest.fn().mockResolvedValue(
        selector.includes('sender')
          ? 'ChatGPT'
          : 'Your temporary ChatGPT login code',
      ),
    }));
    const rows = {
      count: jest.fn().mockResolvedValue(2),
      nth: jest.fn(),
    };
    const firstRow = {
      locator: firstRowLocator,
      click: jest.fn().mockResolvedValue(undefined),
    };
    const newestMatchingRow = {
      locator: matchingRowLocator,
      click: jest.fn().mockResolvedValue(undefined),
    };
    rows.nth.mockReturnValueOnce(firstRow).mockReturnValueOnce(newestMatchingRow);
    page.locator = jest.fn((selector: string) =>
      selector === '[data-testid^="message-item:"]'
        ? rows
        : {
            count: jest.fn().mockResolvedValue(0),
            nth: jest.fn(),
            innerText: jest.fn().mockResolvedValue(''),
          },
    ) as never;
    const service = new ProtonMailService(config);

    await service['openNewestMailAndReadBody'](page);

    expect(firstRow.click).not.toHaveBeenCalled();
    expect(newestMatchingRow.click).toHaveBeenCalled();
  });
  it('reads the rendered message body from the selected email iframe', async () => {
    const { page } = createBrowser();
    const iframeBody = {
      count: jest.fn().mockResolvedValue(1),
      innerText: jest.fn().mockResolvedValue(
        'Your temporary ChatGPT login code is 654321',
      ),
    };
    page.frameLocator = jest.fn().mockReturnValue({
      locator: jest.fn().mockReturnValue(iframeBody),
    });
    page.locator = jest.fn((selector: string) => {
      if (selector === '[data-testid^="message-item:"]') {
        const row = {
          count: jest.fn().mockResolvedValue(1),
          nth: jest.fn().mockReturnValue({
            click: jest.fn().mockResolvedValue(undefined),
            locator: jest.fn((nestedSelector: string) => ({
              count: jest.fn().mockResolvedValue(1),
              getAttribute: jest.fn().mockResolvedValue(
                nestedSelector.includes('sender')
                  ? 'noreply@tm.openai.com'
                  : 'Your temporary ChatGPT login code',
              ),
              innerText: jest.fn().mockResolvedValue(
                nestedSelector.includes('sender')
                  ? 'ChatGPT'
                  : 'Your temporary ChatGPT login code',
              ),
            })),
            innerText: jest.fn().mockResolvedValue(
              'Your temporary ChatGPT login code',
            ),
          }),
        };
        return row;
      }

      return {
        count: jest.fn().mockResolvedValue(0),
        nth: jest.fn(),
        innerText: jest.fn().mockResolvedValue(''),
      };
    }) as never;
    const service = new ProtonMailService(config);

    await expect(service['openNewestMailAndReadBody'](page)).resolves.toContain(
      '654321',
    );
    expect(page.frameLocator).toHaveBeenCalledWith(
      'iframe[data-testid="content-iframe"]',
    );
  });
  it('extracts a code from changed OpenAI wording without requiring the sender text', () => {
    const service = new ProtonMailService(config);

    expect(
      service['extractCode']('Your OpenAI sign-in passcode is 654321'),
    ).toBe('654321');
  });

  it('ignores unrelated six-digit numbers without verification context', () => {
    const service = new ProtonMailService(config);

    expect(service['extractCode']('Order reference: 654321')).toBeUndefined();
  });
});
