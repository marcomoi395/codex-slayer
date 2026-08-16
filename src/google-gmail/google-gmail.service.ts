import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import { GOOGLE_GMAIL_CONFIG } from './google-gmail.constants';
import type { GoogleGmailConfig } from './google-gmail.config';
import type {
  GoogleGmailAuthorization,
  GoogleGmailConnection,
  GoogleGmailTokenResponse,
  GoogleGmailTokens,
} from './google-gmail.types';

@Injectable()
export class GoogleGmailService {
  private readonly pendingStates = new Map<string, number>();
  private readonly connections = new Map<string, GoogleGmailTokens>();

  constructor(
    @Inject(GOOGLE_GMAIL_CONFIG) private readonly config: GoogleGmailConfig,
  ) {}

  createAuthorization(): GoogleGmailAuthorization {
    this.assertConfigured();
    const state = randomBytes(32).toString('base64url');
    const createdAt = Date.now();
    this.pendingStates.set(state, createdAt);

    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: this.config.scope,
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent',
      state,
    });


    return {
      state,
      authorizationUrl: `${this.config.authorizationUrl}?${params.toString()}`,
      createdAt,
    };
  }

  async exchangeCode(code: string, state: string): Promise<GoogleGmailConnection> {
    this.assertConfigured();
    const createdAt = this.pendingStates.get(state);
    this.pendingStates.delete(state);

    if (!createdAt || Date.now() - createdAt > this.config.stateTtlMs) {
      throw new UnauthorizedException('Invalid or expired OAuth state');
    }

    const response = await fetch(this.config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: this.config.redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    if (!response.ok) {
      throw new UnauthorizedException('Google OAuth token exchange failed');
    }

    const payload: unknown = await response.json();
    const tokenResponse = this.asTokenResponse(payload);

    const tokens: GoogleGmailTokens = {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      expiresAt: tokenResponse.expires_in
        ? Date.now() + tokenResponse.expires_in * 1000
        : undefined,
      scope: tokenResponse.scope,
      tokenType: tokenResponse.token_type,
    };
    const connectionId = randomBytes(24).toString('base64url');
    this.connections.set(connectionId, tokens);

    return { connectionId, scope: tokens.scope };
  }

  getTokens(connectionId: string): GoogleGmailTokens | undefined {
    return this.connections.get(connectionId);
  }

  private assertConfigured(): void {
    if (!this.config.clientId || !this.config.clientSecret || !this.config.redirectUri) {
      throw new Error(
        'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI are required',
      );
    }
  }

  private asTokenResponse(value: unknown): GoogleGmailTokenResponse {
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof Reflect.get(value, 'access_token') !== 'string'
    ) {
      throw new UnauthorizedException('Invalid Google OAuth token response');
    }

    return value as GoogleGmailTokenResponse;
  }
}
