import { writeFile } from 'node:fs/promises';

import { GoogleGmailController } from './google-gmail.controller';
import type { GoogleGmailService } from './google-gmail.service';

jest.mock('node:fs/promises', () => ({
  writeFile: jest.fn(),
}));

describe('GoogleGmailController', () => {
  it('saves emailAddress to credential.json after OAuth callback', async () => {
    const service = {
      exchangeCode: jest.fn().mockResolvedValue({
        connectionId: 'connection-id',
        emailAddress: 'user@example.com',
        accessToken: 'access-token',
      }),
    } as unknown as GoogleGmailService;
    const controller = new GoogleGmailController(service);

    await controller.callback('code', 'state');

    expect(writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/credential\.json$/),
      expect.stringContaining('"emailAddress": "user@example.com"'),
    );
  });

  it('checks whether an email exists in credential.json', async () => {
    const service = {
      hasCredentialEmail: jest.fn().mockResolvedValue(true),
    } as unknown as GoogleGmailService;
    const controller = new GoogleGmailController(service);

    await expect(
      controller.checkEmail({ email: 'c.ontact.youngmarco@gmail.com' }),
    ).resolves.toEqual({ exists: true });
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
