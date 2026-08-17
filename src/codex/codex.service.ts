import {
  BadRequestException,
  Inject,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer, type Server } from 'node:http';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright-core';

import { CODEX_CONFIG } from './codex.constants';
import type { CodexConfig } from './codex.config';
import { GoogleGmailService } from '../google-gmail/google-gmail.service';
import type {
  CodexAccountRequest,
  CodexAuthorization,
  CodexConnection,
  CodexStartResponse,
  CodexTokenResponse,
} from './codex.types';

interface PendingAuthorization extends CodexAuthorization {
  codeVerifier: string;
  redirectUri: string;
}
interface ResolvedAccountCredentials extends CodexAccountRequest {
  connectionId: string;
}

@Injectable()
export class CodexService implements OnModuleDestroy {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly connections = new Map<string, CodexConnection>();
  private browser?: Browser;
  private callbackServer?: Server;

  constructor(
    @Inject(CODEX_CONFIG) private readonly config: CodexConfig,
    private readonly googleGmailService: GoogleGmailService,
  ) {}

  async startAccountFlow(
    credentials: CodexAccountRequest,
  ): Promise<CodexStartResponse> {
    const connectionId = await this.validateAccountCredentials(credentials);
    const authorization = await this.createAuthorizationLink();
    try {
      await this.openBrowser(authorization.authorizationUrl, {
        ...credentials,
        connectionId,
      });
    } catch (error) {
      this.pending.delete(authorization.state);
      throw error;
    }
    return authorization;
  }

  async createAuthorizationLink(): Promise<CodexStartResponse> {
    if (this.pending.size > 0) {
      throw new BadRequestException(
        'A Codex authorization flow is already active',
      );
    }

    const codeVerifier = randomBytes(32).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    const redirectUri = this.getRedirectUri();
    const createdAt = Date.now();
    const authorizationUrl = this.buildAuthorizationUrl(
      redirectUri,
      state,
      codeChallenge,
    );

    this.pending.set(state, {
      state,
      authorizationUrl,
      createdAt,
      codeVerifier,
      redirectUri,
    });
    await this.startCallbackServer();

    return {
      state,
      authorizationUrl,
      createdAt,
      callbackUrl: redirectUri,
      browserUrl: this.config.createAccountUrl,
    };
  }

  async handleCallback(
    code?: string,
    state?: string,
    error?: string,
  ): Promise<CodexConnection> {
    console.log('[codex] callback received', {
      hasCode: Boolean(code),
      hasState: Boolean(state),
      hasError: Boolean(error),
    });
    if (error) throw new UnauthorizedException(`Codex OAuth failed: ${error}`);
    if (!code || !state) {
      throw new BadRequestException('Codex callback requires code and state');
    }

    const session = this.pending.get(state);
    this.pending.delete(state);
    console.log('[codex] callback state checked', { valid: Boolean(session) });
    if (!session || Date.now() - session.createdAt > this.config.stateTtlMs) {
      throw new UnauthorizedException(
        'Codex OAuth state is invalid or expired',
      );
    }

    console.log('[codex] exchanging authorization code', {
      tokenUrl: this.config.tokenUrl,
    });
    const response = await fetch(this.config.tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.config.clientId,
        code,
        redirect_uri: session.redirectUri,
        code_verifier: session.codeVerifier,
      }),
    });

    console.log('[codex] token response received', {
      status: response.status,
      contentType: response.headers.get('content-type'),
    });
    if (!response.ok) {
      throw new UnauthorizedException('Codex token exchange failed');
    }

    const token = await this.parseTokenResponse(response);
    console.log('[codex] token parsed', {
      hasAccessToken: Boolean(token.access_token),
      hasRefreshToken: Boolean(token.refresh_token),
      expiresIn: token.expires_in,
    });
    const connection: CodexConnection = {
      connectionId: randomUUID(),
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      idToken: token.id_token,
      expiresIn: token.expires_in,
      expiresAt: token.expires_in
        ? Date.now() + token.expires_in * 1000
        : undefined,
      scope: token.scope,
      tokenType: token.token_type,
    };
    this.connections.set(connection.connectionId, connection);
    await this.closeBrowser();
    await this.closeCallbackServer();
    return connection;
  }

  getConnection(connectionId: string): CodexConnection | undefined {
    return this.connections.get(connectionId);
  }

  async onModuleDestroy(): Promise<void> {
    await this.closeBrowser();
    await this.closeCallbackServer();
  }
  private async validateAccountCredentials(
    credentials: CodexAccountRequest,
  ): Promise<string> {
    if (
      !credentials ||
      typeof credentials.email !== 'string' ||
      !credentials.email.trim() ||
      typeof credentials.password !== 'string' ||
      !credentials.password
    ) {
      throw new BadRequestException('Email and password are required');
    }

    const connectionId =
      await this.googleGmailService.getCredentialConnectionId(
        credentials.email,
      );
    if (!connectionId) {
      throw new UnauthorizedException(
        'Gmail credential is not authorized for this email',
      );
    }

    return connectionId;
  }

  private buildAuthorizationUrl(
    redirectUri: string,
    state: string,
    codeChallenge: string,
  ): string {
    const url = new URL(this.config.authorizationUrl);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
      scope: this.config.scope,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'codex_cli_rs',
    })) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private getRedirectUri(): string {
    return `http://${this.config.callbackHost}:${this.config.callbackPort}${this.config.callbackPath}`;
  }

  private async startCallbackServer(): Promise<void> {
    if (this.callbackServer) return;

    this.callbackServer = createServer((request, response) => {
      const url = new URL(request.url ?? '/', this.getRedirectUri());
      if (url.pathname !== this.config.callbackPath) {
        response.writeHead(404).end();
        return;
      }

      void this.handleCallback(
        url.searchParams.get('code') ?? undefined,
        url.searchParams.get('state') ?? undefined,
        url.searchParams.get('error') ?? undefined,
      )
        .then(() =>
          response
            .writeHead(200)
            .end('Codex authorization complete. You may close this tab.'),
        )
        .catch(() =>
          response.writeHead(400).end('Codex authorization failed.'),
        );
    });
    await new Promise<void>((resolve, reject) => {
      this.callbackServer?.once('error', reject);
      this.callbackServer?.listen(
        this.config.callbackPort,
        this.config.callbackHost,
        () => resolve(),
      );
    });
  }


  private async openBrowser(
    authorizationUrl: string,
    credentials: ResolvedAccountCredentials,
  ): Promise<void> {
    let page: Page;
    try {
      this.browser = await this.launchBrowser();
      const context = await this.browser.newContext();
      page = await context.newPage();
      await page.goto(authorizationUrl, {
        waitUntil: 'domcontentloaded',
      });
    } catch {
      await this.closeBrowser();
      await this.closeCallbackServer();
      throw new ServiceUnavailableException(
        'Unable to start browser. Install the selected browser runtime first.',
      );
    }

    try {
      const signUpLink = page.getByRole('link', { name: /sign up/i });
      await signUpLink.waitFor({ state: 'visible', timeout: 10_000 });
      await signUpLink.click();

      const emailInput = page.locator('input[type="email"]');
      await emailInput.waitFor({ state: 'visible', timeout: 10_000 });
      await emailInput.fill(credentials.email);

      const continueButton = page.locator('button[type="submit"]');
      await continueButton.waitFor({ state: 'visible', timeout: 10_000 });
      await continueButton.click();

      const passwordInput = page.locator('input[type="password"]');
      await passwordInput.waitFor({ state: 'visible', timeout: 10_000 });
      await passwordInput.fill(credentials.password);
      await continueButton.click();

      const codeInput = page.locator(
        'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name*="code" i], input[id*="code" i]',
      );
      await codeInput.waitFor({ state: 'visible', timeout: 30_000 });
      const verificationCode =
        await this.googleGmailService.getLatestOpenAiVerificationCode(
          credentials.connectionId,
        );
      await codeInput.fill(verificationCode);
      await page.locator('button[type="submit"]').click();
    } catch {
      // Keep the browser open for manual completion if the provider UI changes.
    }
  }
  private async launchBrowser(): Promise<Browser> {
    if (this.config.browserEngine === 'camoufox') {
      // Camoufox is ESM-only; load it only for the explicit opt-in engine.
      const { Camoufox } = await import('camoufox-js');
      return Camoufox({
        headless: false,
        humanize: 0.5,
      });
    }

    return chromium.launch({ headless: false }) as unknown as Browser;
  }

  private async closeBrowser(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
  }

  private async closeCallbackServer(): Promise<void> {
    const server = this.callbackServer;
    this.callbackServer = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async parseTokenResponse(
    response: Response,
  ): Promise<CodexTokenResponse> {
    const value: unknown = await response.json();
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as { access_token?: unknown }).access_token !== 'string'
    ) {
      throw new UnauthorizedException('Codex token response is invalid');
    }
    return value as CodexTokenResponse;
  }
}
