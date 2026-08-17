import { readFile } from 'node:fs/promises';

import { UnauthorizedException } from '@nestjs/common';

jest.mock('node:fs/promises', () => ({
  readFile: jest.fn(),
}));
import { GoogleGmailService } from './google-gmail.service';
import type { GoogleGmailConfig } from './google-gmail.config';

const config: GoogleGmailConfig = {
  clientId: 'client-id.apps.googleusercontent.com',
  clientSecret: 'client-secret',
  redirectUri: 'http://localhost:3000/auth/google/gmail/callback',
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scope: 'https://www.googleapis.com/auth/gmail.readonly',
  stateTtlMs: 600_000,
};

describe('GoogleGmailService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates an authorization URL with readonly Gmail scope and state', () => {
    const service = new GoogleGmailService(config);
    const authorization = service.createAuthorization();
    const params = new URL(authorization.authorizationUrl).searchParams;

    expect(params.get('client_id')).toBe(config.clientId);
    expect(params.get('scope')).toBe(config.scope);
    expect(params.get('state')).toBe(authorization.state);
    expect(params.get('access_type')).toBe('offline');
  });

  it('exchanges tokens and includes the Gmail email address', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-token',
            refresh_token: 'refresh-token',
            expires_in: 3600,
            scope: config.scope,
            token_type: 'Bearer',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ emailAddress: 'user@example.com' }), {
          status: 200,
        }),
      );
    const service = new GoogleGmailService(config);
    const { state } = service.createAuthorization();

    const connection = await service.exchangeCode('code', state);

    expect(connection).toMatchObject({
      connectionId: expect.any(String),
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
      scope: config.scope,
      tokenType: 'Bearer',
      emailAddress: 'user@example.com',
    });
    expect(service.getTokens(connection.connectionId)).toMatchObject({
      accessToken: 'access-token',
      emailAddress: 'user@example.com',
    });
    await expect(service.exchangeCode('code', state)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects malformed Google token responses', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const service = new GoogleGmailService(config);
    const { state } = service.createAuthorization();

    await expect(service.exchangeCode('code', state)).rejects.toThrow(
      'Invalid Google OAuth token response',
    );
  });
  it('returns the verification code from the latest OpenAI email', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === config.tokenUrl) {
        return new Response(JSON.stringify({ access_token: 'access-token' }), {
          status: 200,
        });
      }
      if (url.includes('/users/me/profile')) {
        return new Response(
          JSON.stringify({ emailAddress: 'user@example.com' }),
          { status: 200 },
        );
      }

      if (url.includes('/messages?')) {
        return new Response(
          JSON.stringify({ messages: [{ id: 'latest-message' }] }),
          {
            status: 200,
          },
        );
      }

      return new Response(
        JSON.stringify({
          payload: {
            mimeType: 'text/plain',
            body: {
              data: Buffer.from(
                'Enter this temporary verification code to continue:\n\n602464',
              ).toString('base64url'),
            },
          },
        }),
        { status: 200 },
      );
    });
    const service = new GoogleGmailService(config);
    const { state } = service.createAuthorization();
    const { connectionId } = await service.exchangeCode('code', state);

    await expect(
      service.getLatestOpenAiVerificationCode(connectionId),
    ).resolves.toBe('602464');
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=from%3Anoreply%40tm.openai.com&maxResults=20',
      ),
      expect.objectContaining({
        headers: { Authorization: 'Bearer access-token' },
      }),
    );
  });
  it('gets a verification code for the authorized credential email', async () => {
    jest.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        credential: {
          connectionId: 'gmail-connection',
          emailAddress: 'user@example.com',
        },
      }),
    );
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/messages?')) {
        return new Response(JSON.stringify({ messages: [{ id: 'message' }] }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          payload: {
            body: {
              data: Buffer.from(
                'Enter this temporary verification code to continue:\n\n123456',
              ).toString('base64url'),
            },
          },
        }),
        { status: 200 },
      );
    });
    const service = new GoogleGmailService(config);
    const connections = Reflect.get(service, 'connections');
    if (!(connections instanceof Map)) {
      throw new Error('Gmail test connection store unavailable');
    }
    connections.set('gmail-connection', { accessToken: 'access-token' });

    await expect(
      service.getCredentialConnectionId('user@example.com'),
    ).resolves.toBe('gmail-connection');
  });
  it('ignores unrelated six-digit numbers before the verification code', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === config.tokenUrl) {
        return new Response(JSON.stringify({ access_token: 'access-token' }), {
          status: 200,
        });
      }
      if (url.includes('/users/me/profile')) {
        return new Response(
          JSON.stringify({ emailAddress: 'user@example.com' }),
          { status: 200 },
        );
      }

      if (url.includes('/messages?')) {
        return new Response(
          JSON.stringify({ messages: [{ id: 'latest-message' }] }),
          {
            status: 200,
          },
        );
      }

      return new Response(
        JSON.stringify({
          payload: {
            body: {
              data: Buffer.from(
                'Message ID: 202123\nEnter this temporary verification code to continue:\n\n654321',
              ).toString('base64url'),
            },
          },
        }),
        { status: 200 },
      );
    });
    const service = new GoogleGmailService(config);
    const { state } = service.createAuthorization();
    const { connectionId } = await service.exchangeCode('code', state);

    await expect(
      service.getLatestOpenAiVerificationCode(connectionId),
    ).resolves.toBe('654321');
  });
  it('extracts the code from the OpenAI HTML verification paragraph', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === config.tokenUrl) {
        return new Response(JSON.stringify({ access_token: 'access-token' }), {
          status: 200,
        });
      }

      if (url.includes('/users/me/profile')) {
        return new Response(
          JSON.stringify({ emailAddress: 'user@example.com' }),
          { status: 200 },
        );
      }

      if (url.includes('/messages?')) {
        return new Response(
          JSON.stringify({ messages: [{ id: 'html-message' }] }),
          {
            status: 200,
          },
        );
      }

      return new Response(
        JSON.stringify({
          payload: {
            body: {
              data: Buffer.from(
                '<p>Enter this temporary verification code to continue:</p><p style="font-size:24px">954097</p>',
              ).toString('base64url'),
            },
          },
        }),
        { status: 200 },
      );
    });
    const service = new GoogleGmailService(config);
    const { state } = service.createAuthorization();
    const { connectionId } = await service.exchangeCode('code', state);

    await expect(
      service.getLatestOpenAiVerificationCode(connectionId),
    ).resolves.toBe('954097');
  });
  it('checks multiple matching emails until it finds a verification code', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === config.tokenUrl) {
        return new Response(JSON.stringify({ access_token: 'access-token' }), {
          status: 200,
        });
      }
      if (url.includes('/users/me/profile')) {
        return new Response(
          JSON.stringify({ emailAddress: 'user@example.com' }),
          { status: 200 },
        );
      }

      if (url.includes('/messages?')) {
        return new Response(
          JSON.stringify({
            messages: [{ id: 'newest-email' }, { id: 'verification-email' }],
          }),
          { status: 200 },
        );
      }

      if (url.includes('/newest-email?')) {
        return new Response(
          JSON.stringify({
            payload: {
              headers: [{ name: 'Subject', value: 'Other OpenAI email' }],
              body: { data: Buffer.from('No code here').toString('base64url') },
            },
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          payload: {
            headers: [
              {
                name: 'Subject',
                value: 'Your temporary ChatGPT verification code',
              },
            ],
            body: {
              data: Buffer.from('Your verification code is 765432').toString(
                'base64url',
              ),
            },
          },
        }),
        { status: 200 },
      );
    });
    const service = new GoogleGmailService(config);
    const { state } = service.createAuthorization();
    const { connectionId } = await service.exchangeCode('code', state);

    await expect(
      service.getLatestOpenAiVerificationCode(connectionId),
    ).resolves.toBe('765432');
  });

  it('throws when no OpenAI verification email exists', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      if (String(input) === config.tokenUrl) {
        return new Response(JSON.stringify({ access_token: 'access-token' }), {
          status: 200,
        });
      }
      if (String(input).includes('/users/me/profile')) {
        return new Response(
          JSON.stringify({ emailAddress: 'user@example.com' }),
          { status: 200 },
        );
      }

      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    });
    const service = new GoogleGmailService(config);
    const { state } = service.createAuthorization();
    const { connectionId } = await service.exchangeCode('code', state);

    await expect(
      service.getLatestOpenAiVerificationCode(connectionId),
    ).rejects.toThrow('OpenAI verification email not found');
  });

  it('matches Gmail dot aliases in credential.json', async () => {
    jest.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        credential: { emailAddress: 'contact.youngmarco@gmail.com' },
      }),
    );
    const service = new GoogleGmailService(config);

    await expect(
      service.hasCredentialEmail('c.ontact.youngmarco@gmail.com'),
    ).resolves.toBe(true);
  });

  it('returns false when credential email does not match', async () => {
    jest.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        credential: { emailAddress: 'contact.youngmarco@gmail.com' },
      }),
    );
    const service = new GoogleGmailService(config);

    await expect(
      service.hasCredentialEmail('other@example.com'),
    ).resolves.toBe(false);
  });
});
