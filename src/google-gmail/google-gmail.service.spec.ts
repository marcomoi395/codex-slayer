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
});
