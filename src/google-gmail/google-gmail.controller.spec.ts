import { readFile, writeFile } from 'node:fs/promises';

import { GoogleGmailController } from './google-gmail.controller';
import type { GoogleGmailService } from './google-gmail.service';

jest.mock('node:fs/promises', () => ({
  readFile: jest.fn(),
  writeFile: jest.fn(),
}));

describe('GoogleGmailController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  it('appends a new credential without removing existing credentials', async () => {
    jest.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        credentials: [
          {
            connectionId: 'old-connection',
            emailAddress: 'old@example.com',
          },
        ],
      }),
    );
    const service = {
      exchangeCode: jest.fn().mockResolvedValue({
        connectionId: 'new-connection',
        emailAddress: 'new@example.com',
        accessToken: 'new-access-token',
      }),
    } as unknown as GoogleGmailService;
    const controller = new GoogleGmailController(service);

    await controller.callback('code', 'state');

    expect(JSON.parse(jest.mocked(writeFile).mock.calls[0][1] as string)).toEqual({
      credentials: [
        {
          connectionId: 'old-connection',
          emailAddress: 'old@example.com',
        },
        expect.objectContaining({
          connectionId: 'new-connection',
          emailAddress: 'new@example.com',
        }),
      ],
    });
  });

  it('saves emailAddress to credential.json after OAuth callback', async () => {
    jest.mocked(readFile).mockRejectedValueOnce(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );
    const service = {
      exchangeCode: jest.fn().mockResolvedValue({
        connectionId: 'connection-id',
        emailAddress: 'user@example.com',
        accessToken: 'access-token',
      }),
    } as unknown as GoogleGmailService;
    const controller = new GoogleGmailController(service);

    await expect(controller.callback('code', 'state')).resolves.toEqual({
      url: '/dashboard/',
      statusCode: 302,
    });
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/credential\.json$/),
      expect.stringContaining('"emailAddress": "user@example.com"'),
      'utf8',
    );
  });

  it('returns the connection ID for an authorized email', async () => {
    const service = {
      getCredentialConnectionId: jest
        .fn()
        .mockResolvedValue('gmail-connection-id'),
    } as unknown as GoogleGmailService;
    const controller = new GoogleGmailController(service);

    await expect(
      controller.checkEmail({ email: 'c.ontact.youngmarco@gmail.com' }),
    ).resolves.toEqual({ connectionId: 'gmail-connection-id' });
  });

  it('rejects an empty email check request', async () => {
    const service = {
      hasCredentialEmail: jest.fn(),
    } as unknown as GoogleGmailService;
    const controller = new GoogleGmailController(service);

    await expect(controller.checkEmail({ email: ' ' })).rejects.toThrow(
      'email is required',
    );
  });
});
