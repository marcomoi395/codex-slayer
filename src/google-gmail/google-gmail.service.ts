import {
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { GOOGLE_GMAIL_CONFIG } from './google-gmail.constants';
import type { GoogleGmailConfig } from './google-gmail.config';
import type {
  GoogleGmailAuthorization,
  GoogleGmailConnection,
  GoogleGmailConnectionSummary,
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

  async exchangeCode(
    code: string,
    state: string,
  ): Promise<GoogleGmailConnection> {
    console.log('[gmail] callback exchange started', {
      hasCode: Boolean(code),
      hasState: Boolean(state),
    });
    this.assertConfigured();
    const createdAt = this.pendingStates.get(state);
    this.pendingStates.delete(state);

    if (!createdAt || Date.now() - createdAt > this.config.stateTtlMs) {
      console.log('[gmail] oauth state invalid or expired');
      throw new UnauthorizedException('Invalid or expired OAuth state');
    }

    console.log('[gmail] exchanging authorization code', {
      tokenUrl: this.config.tokenUrl,
    });
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

    console.log('[gmail] token response received', {
      status: response.status,
      contentType: response.headers.get('content-type'),
    });
    if (!response.ok) {
      throw new UnauthorizedException('Google OAuth token exchange failed');
    }

    const payload: unknown = await response.json();
    const tokenResponse = this.asTokenResponse(payload);
    console.log('[gmail] token parsed', {
      hasAccessToken: Boolean(tokenResponse.access_token),
      hasRefreshToken: Boolean(tokenResponse.refresh_token),
      expiresIn: tokenResponse.expires_in,
    });

    console.log('[gmail] loading profile');
    const profileResponse = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      { headers: { Authorization: `Bearer ${tokenResponse.access_token}` } },
    );
    console.log('[gmail] profile response received', {
      status: profileResponse.status,
      contentType: profileResponse.headers.get('content-type'),
    });
    if (!profileResponse.ok) {
      throw new UnauthorizedException('Gmail profile lookup failed');
    }

    const profile: unknown = await profileResponse.json();
    const emailValue =
      profile && typeof profile === 'object'
        ? Reflect.get(profile, 'emailAddress')
        : undefined;
    if (typeof emailValue !== 'string' || !emailValue) {
      throw new UnauthorizedException('Gmail profile email is missing');
    }
    const emailAddress = emailValue;

    const tokens: GoogleGmailTokens = {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      expiresIn: tokenResponse.expires_in,
      expiresAt: tokenResponse.expires_in
        ? Date.now() + tokenResponse.expires_in * 1000
        : undefined,
      scope: tokenResponse.scope,
      tokenType: tokenResponse.token_type,
      emailAddress,
    };
    const connectionId = randomBytes(24).toString('base64url');
    this.connections.set(connectionId, tokens);
    console.log('[gmail] connection stored', { hasConnectionId: true });

    return {
      connectionId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
      tokenType: tokens.tokenType,
      emailAddress: tokens.emailAddress,
    };
  }

  async getCredentialConnectionId(email: string): Promise<string | undefined> {
    const normalizedEmail = this.normalizeCredentialEmail(email);
    for (const credential of await this.readPersistedCredentials()) {
      const credentialEmail = Reflect.get(credential, 'emailAddress');
      const connectionId = Reflect.get(credential, 'connectionId');
      if (
        typeof credentialEmail === 'string' &&
        typeof connectionId === 'string' &&
        this.normalizeCredentialEmail(credentialEmail) === normalizedEmail
      ) {
        return connectionId;
      }
    }
    return undefined;
  }

  async getConnections(): Promise<GoogleGmailConnectionSummary[]> {
    const summaries = new Map<string, GoogleGmailConnectionSummary>();
    for (const credential of await this.readPersistedCredentials()) {
      const connectionId = Reflect.get(credential, 'connectionId');
      const emailAddress = Reflect.get(credential, 'emailAddress');
      if (typeof connectionId !== 'string' || typeof emailAddress !== 'string') {
        continue;
      }
      const expiresAt = Reflect.get(credential, 'expiresAt');
      const scope = Reflect.get(credential, 'scope');
      summaries.set(connectionId, {
        connectionId,
        emailAddress,
        ...(typeof expiresAt === 'number' ? { expiresAt } : {}),
        ...(typeof scope === 'string' ? { scope } : {}),
      });
    }

    for (const [connectionId, tokens] of this.connections) {
      if (typeof tokens.emailAddress !== 'string') continue;
      summaries.set(connectionId, {
        connectionId,
        emailAddress: tokens.emailAddress,
        ...(typeof tokens.expiresAt === 'number'
          ? { expiresAt: tokens.expiresAt }
          : {}),
        ...(typeof tokens.scope === 'string' ? { scope: tokens.scope } : {}),
      });
    }

    return [...summaries.values()];
  }

  async hasCredentialEmail(email: string): Promise<boolean> {
    const normalizedEmail = this.normalizeCredentialEmail(email);
    return (await this.readPersistedCredentials()).some((credential) => {
      const credentialEmail = Reflect.get(credential, 'emailAddress');
      return (
        typeof credentialEmail === 'string' &&
        this.normalizeCredentialEmail(credentialEmail) === normalizedEmail
      );
    });
  }

  async getLatestOpenAiVerificationCode(
    connectionId: string,
    requestedAfterMs?: number,
  ): Promise<string> {
    const persistedCredential = (await this.readPersistedCredentials()).find(
      (credential) =>
        Reflect.get(credential, 'connectionId') === connectionId,
    );
    const runtimeTokens = this.connections.get(connectionId);
    let accessToken =
      persistedCredential &&
      typeof Reflect.get(persistedCredential, 'accessToken') === 'string'
        ? (Reflect.get(persistedCredential, 'accessToken') as string)
        : runtimeTokens?.accessToken;
    const refreshToken =
      persistedCredential &&
      typeof Reflect.get(persistedCredential, 'refreshToken') === 'string'
        ? (Reflect.get(persistedCredential, 'refreshToken') as string)
        : runtimeTokens?.refreshToken;
    if (typeof accessToken !== 'string') {
      throw new UnauthorizedException('Invalid Gmail connection');
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.lookupVerificationCode(
          accessToken,
          requestedAfterMs,
        );
      } catch (error) {
        if (
          attempt === 1 ||
          !refreshToken ||
          !(error instanceof UnauthorizedException) ||
          error.message !== 'Gmail access token expired'
        ) {
          throw error;
        }
        const refreshed = await this.refreshAccessToken(refreshToken);
        accessToken = refreshed.accessToken;
        this.connections.set(connectionId, {
          ...(runtimeTokens ?? {}),
          ...(persistedCredential ?? {}),
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? refreshToken,
          expiresIn: refreshed.expiresIn,
          expiresAt: refreshed.expiresAt,
        });
        await this.persistRefreshedCredential(
          connectionId,
          accessToken,
          refreshed,
          persistedCredential,
        );
      }
    }

    throw new UnauthorizedException('Gmail messages lookup failed');
  }

  private async lookupVerificationCode(
    accessToken: string,
    requestedAfterMs?: number,
  ): Promise<string> {
    const query = new URLSearchParams({
      q: requestedAfterMs
        ? `from:noreply@tm.openai.com after:${Math.floor(requestedAfterMs / 1000)}`
        : 'from:noreply@tm.openai.com',
      maxResults: '20',
    });
    const listResponse = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${query.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (listResponse.status === 401) {
      throw new UnauthorizedException('Gmail access token expired');
    }
    if (!listResponse.ok) {
      throw new UnauthorizedException('Gmail messages lookup failed');
    }

    const messageIds = this.asMessageIds(await listResponse.json());
    if (messageIds.length === 0) {
      throw new NotFoundException('OpenAI verification email not found');
    }

    for (const messageId of messageIds) {
      const messageResponse = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (messageResponse.status === 401) {
        throw new UnauthorizedException('Gmail access token expired');
      }
      if (!messageResponse.ok) {
        throw new UnauthorizedException('Gmail message lookup failed');
      }

      const messagePayload: unknown = await messageResponse.json();
      const internalDate =
        messagePayload && typeof messagePayload === 'object'
          ? Reflect.get(messagePayload, 'internalDate')
          : undefined;
      if (
        requestedAfterMs !== undefined &&
        (typeof internalDate !== 'string' ||
          Number(internalDate) <= requestedAfterMs)
      ) {
        continue;
      }
      const body = this.extractMessageText(messagePayload);
      const code =
        body.match(
          /Enter this temporary verification code to continue:[\s\S]*?<p[^>]*>[\s\S]*?\b(\d{6})\b/i,
        )?.[1] ??
        body.match(/\bverification\s+code\b[\s\S]{0,100}?\b(\d{6})\b/i)?.[1];
      if (code) return code;
    }

    throw new NotFoundException('OpenAI verification code not found');
  }

  private async refreshAccessToken(
    refreshToken: string,
  ): Promise<GoogleGmailTokens> {
    const response = await fetch(this.config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!response.ok) {
      throw new UnauthorizedException('Google OAuth token refresh failed');
    }
    const tokenResponse = this.asTokenResponse(await response.json());
    return {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      expiresIn: tokenResponse.expires_in,
      expiresAt: tokenResponse.expires_in
        ? Date.now() + tokenResponse.expires_in * 1000
        : undefined,
      scope: tokenResponse.scope,
      tokenType: tokenResponse.token_type,
    };
  }

  private async persistRefreshedCredential(
    connectionId: string,
    accessToken: string,
    refreshed: GoogleGmailTokens,
    persistedCredential?: Record<string, unknown>,
  ): Promise<void> {
    const credentials = await this.readPersistedCredentials();
    const nextCredentials = credentials.map((credential) =>
      Reflect.get(credential, 'connectionId') === connectionId
        ? {
            ...credential,
            accessToken,
            ...(refreshed.refreshToken
              ? { refreshToken: refreshed.refreshToken }
              : {}),
            expiresIn: refreshed.expiresIn,
            expiresAt: refreshed.expiresAt,
          }
        : credential,
    );
    if (
      persistedCredential &&
      !nextCredentials.some(
        (credential) =>
          Reflect.get(credential, 'connectionId') === connectionId,
      )
    ) {
      nextCredentials.push({
        ...persistedCredential,
        accessToken,
        ...(refreshed.refreshToken
          ? { refreshToken: refreshed.refreshToken }
          : {}),
        expiresIn: refreshed.expiresIn,
        expiresAt: refreshed.expiresAt,
      });
    }
    await writeFile(
      resolve(process.cwd(), 'credential.json'),
      JSON.stringify({ credentials: nextCredentials }, null, 2),
      'utf8',
    );
  }

  private asMessageIds(value: unknown): string[] {
    if (typeof value !== 'object' || value === null) {
      return [];
    }

    const messages = Reflect.get(value, 'messages');
    if (!Array.isArray(messages)) {
      return [];
    }

    return messages.flatMap((message) => {
      const id =
        message && typeof message === 'object'
          ? Reflect.get(message, 'id')
          : undefined;
      return typeof id === 'string' ? [id] : [];
    });
  }

  private extractMessageText(value: unknown): string {
    if (typeof value !== 'object' || value === null) {
      return '';
    }

    const body = Reflect.get(value, 'body');
    const data =
      body && typeof body === 'object' ? Reflect.get(body, 'data') : undefined;
    const decoded =
      typeof data === 'string'
        ? Buffer.from(data, 'base64url').toString('utf8')
        : '';
    const parts = Reflect.get(value, 'parts');
    const nestedText = Array.isArray(parts)
      ? parts.map((part) => this.extractMessageText(part)).join('\n')
      : '';
    const payload = Reflect.get(value, 'payload');
    const payloadText = payload ? this.extractMessageText(payload) : '';

    return `${decoded}\n${nestedText}\n${payloadText}`;
  }
  private async readPersistedCredentials(): Promise<Record<string, unknown>[]> {
    try {
      const content = await readFile(
        resolve(process.cwd(), 'credential.json'),
        'utf8',
      );
      const parsed: unknown = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (value): value is Record<string, unknown> =>
            typeof value === 'object' && value !== null,
        );
      }
      if (!parsed || typeof parsed !== 'object') return [];
      const credentials = Reflect.get(parsed, 'credentials');
      if (Array.isArray(credentials)) {
        return credentials.filter(
          (value): value is Record<string, unknown> =>
            typeof value === 'object' && value !== null,
        );
      }
      const credential = Reflect.get(parsed, 'credential');
      return credential && typeof credential === 'object' ? [credential] : [];
    } catch {
      return [];
    }
  }

  getTokens(connectionId: string): GoogleGmailTokens | undefined {
    return this.connections.get(connectionId);
  }

  private assertConfigured(): void {
    if (
      !this.config.clientId ||
      !this.config.clientSecret ||
      !this.config.redirectUri
    ) {
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

  private normalizeCredentialEmail(email: string): string {
    const normalized = email.trim().toLowerCase();
    const separator = normalized.lastIndexOf('@');
    if (separator < 1) {
      return normalized;
    }

    const localPart = normalized.slice(0, separator);
    const domain = normalized.slice(separator + 1);
    return domain === 'gmail.com'
      ? `${localPart.replaceAll('.', '')}@${domain}`
      : normalized;
  }
}
