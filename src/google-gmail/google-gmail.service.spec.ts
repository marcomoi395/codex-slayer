import { UnauthorizedException } from '@nestjs/common';

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
  showTokens: false,
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

  it('exchanges a valid state once and maps Google tokens', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
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
    );
    const service = new GoogleGmailService(config);
    const { state } = service.createAuthorization();

    const connection = await service.exchangeCode('code', state);

    expect(connection).toMatchObject({ scope: config.scope });
    expect(connection.connectionId).toBeTruthy();
    expect(service.getTokens(connection.connectionId)).toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      scope: config.scope,
      tokenType: 'Bearer',
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
  it('returns Gmail tokens only when token display is enabled', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
        }),
        { status: 200 },
      ),
    );
    const service = new GoogleGmailService({ ...config, showTokens: true });
    const { state } = service.createAuthorization();

    await expect(service.exchangeCode('code', state)).resolves.toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
  });
  it('returns the verification code from the latest OpenAI email', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === config.tokenUrl) {
        return new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200 });
      }

      if (url.includes('/messages?')) {
        return new Response(JSON.stringify({ messages: [{ id: 'latest-message' }] }), {
          status: 200,
        });
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

    await expect(service.getLatestOpenAiVerificationCode(connectionId)).resolves.toBe('602464');
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=from%3Anoreply%40tm.openai.com&maxResults=20',
      ),
      expect.objectContaining({
        headers: { Authorization: 'Bearer access-token' },
      }),
    );
  });
  it('ignores unrelated six-digit numbers before the verification code', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === config.tokenUrl) {
        return new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200 });
      }

      if (url.includes('/messages?')) {
        return new Response(JSON.stringify({ messages: [{ id: 'latest-message' }] }), {
          status: 200,
        });
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

    await expect(service.getLatestOpenAiVerificationCode(connectionId)).resolves.toBe('654321');
  });
  it('extracts the code from the OpenAI HTML verification paragraph', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === config.tokenUrl) {
        return new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200 });
      }

      if (url.includes('/messages?')) {
        return new Response(JSON.stringify({ messages: [{ id: 'html-message' }] }), {
          status: 200,
        });
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

    await expect(service.getLatestOpenAiVerificationCode(connectionId)).resolves.toBe('954097');
  });
  it('checks multiple matching emails until it finds a verification code', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === config.tokenUrl) {
        return new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200 });
      }

      if (url.includes('/messages?')) {
        return new Response(
          JSON.stringify({ messages: [{ id: 'newest-email' }, { id: 'verification-email' }] }),
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
            headers: [{ name: 'Subject', value: 'Your temporary ChatGPT verification code' }],
            body: { data: Buffer.from('Your verification code is 765432').toString('base64url') },
          },
        }),
        { status: 200 },
      );
    });
    const service = new GoogleGmailService(config);
    const { state } = service.createAuthorization();
    const { connectionId } = await service.exchangeCode('code', state);

    await expect(service.getLatestOpenAiVerificationCode(connectionId)).resolves.toBe('765432');
  });


  it('throws when no OpenAI verification email exists', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      if (String(input) === config.tokenUrl) {
        return new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200 });
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
});
